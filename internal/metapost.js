// Create PDF file using Metapost (bsaed on rfig).
// This script works with node.js on the server side, not in the browser.
//
// Comments:
//  - In SVG, down is positive y; in Metapost, down is negative y.  This can
//    cause lots of confusion/inconsistencies.  User should use:
//    [10, down(20)] to refer to points.
//    Shifting (p.yshift(3)) shifts down.
// TODO: handle orphans
// @author Percy Liang

var fs = require('fs');
var Path = require('path');
L = sfig.L;

if (!sfig.serverSide) throw 'This script only works on the server side.';

// In rendering Metapost, we only draw the leaves.
function isLeaf(block) {
  // DecoratedLine is technically not a leaf in SVG, but we handle is
  // atomically as a leaf (arrow heads).
  return block.children.length == 0 || block instanceof sfig.DecoratedLine;
}

////////////////////////////////////////////////////////////
// For creating PDF files.
(function() {
  // A Metapost expression is a hierarchical tree which represents a tree.
  // Each expression has
  //  - type (used to do limited type checking)
  //    - numeric
  //    - pair, color
  //    - path
  //    - picture
  //  - func:
  //     - [primitive numeric value] (no arguments)
  //     - [primitive picture value] (no arguments)
  //     - pair or color: arguments is a list of numeric components
  //     - path: arguments is a list of pairs interleaved with connector strings
  //     - other (e.g., +)
  //  - Args: list of arguments to the function
  var MetapostExpr = sfig.MetapostExpr = function(type, func, args) {
    this.type = type;
    this.func = func;
    // Somewhat hacky: if second argument of pair is a number, then negate it.
    var i = -1;
    this.args = args == null ? null : args.map(function(x) {
      i++;
      if (x instanceof MetapostExpr) return x;
      if (x instanceof Array) {
        if (x.length == 2) return MetapostExpr.pair(x);
        if (x.length == 3) return MetapostExpr.color(x);
        throw 'Bad length: ' + x;
      }
      if (sfig.isNumber(x))
        return MetapostExpr.numeric(x);
      return x;  // For miscellaneous items such as '--' in paths
    });
  };

  // If args is null, then func encodes a verbatim string.
  // Scalar
  MetapostExpr.numeric = function(value) { return new MetapostExpr('numeric', value); }
  MetapostExpr.picture = function(value) { return new MetapostExpr('picture', value); }
  MetapostExpr.pair = function(args) { return new MetapostExpr('pair', 'pair', args); }
  MetapostExpr.color = function(args) { return new MetapostExpr('color', 'color', args); }
  // List of pairs interleaved with connector strings
  MetapostExpr.path = function(args) { return new MetapostExpr('path', 'path', args); }

  MetapostExpr.ensureNumeric = function(value) { return value instanceof MetapostExpr ? value : MetapostExpr.numeric(value); }

  // Constructors of various expressions
  MetapostExpr.xypair = function(x, y) { return MetapostExpr.pair([x, y]); }
  MetapostExpr.xpair = function(x) { return MetapostExpr.xypair(x, 0); }
  MetapostExpr.ypair = function(y) { return MetapostExpr.xypair(0, y); }
  MetapostExpr.rgbcolor = function(r, g, b) { return MetapostExpr.color([r/255.0, g/255.0, b/255.0]); }
  MetapostExpr.hexcolor = function(s) {
    var m = s.match(/^#(..)(..)(..)$/);
    if (!m) throw 'Invalid hex color: ' + s;
    return MetapostExpr.color([parseInt(m[1], 16)/255.0, parseInt(m[2], 16)/255.0, parseInt(m[3], 16)/255.0]);
  }
  MetapostExpr.zero = MetapostExpr.numeric(0);
  MetapostExpr.origin = MetapostExpr.xypair(0, 0);
  MetapostExpr.nullpicture = MetapostExpr.picture('nullpicture');

  MetapostExpr.intersectionpoint = function(p1, p2) { return new MetapostExpr('pair', 'intersectionpoint', [p1, p2]); }

  //MetapostExpr.append = function(a, b) { return new MetapostExpr(a.type, 'append', [a, b]); }
  MetapostExpr.draw = function(path, opts) { return new MetapostExpr('picture', 'image', [new MetapostExpr('picture', 'draw', [path].concat(opts))]); }
  MetapostExpr.fill = function(path, opts) { return new MetapostExpr('picture', 'image', [new MetapostExpr('picture', 'fill', [path].concat(opts))]); }
  MetapostExpr.drawarrow = function(path, opts) { return new MetapostExpr('picture', 'image', [new MetapostExpr('picture', 'drawarrow', [path].concat(opts))]); }
  MetapostExpr.drawdblarrow = function(path, opts) { return new MetapostExpr('picture', 'image', [new MetapostExpr('picture', 'drawdblarrow', [path].concat(opts))]); }

  MetapostExpr.rect = function(x1, y1, x2, y2) {
    return MetapostExpr.path([[x1, y1], '--', [x1, y2], '--', [x2, y2], '--', [x2, y1], '--cycle']);
  }

  MetapostExpr.prototype.isZero = function(p) { return this.func == 0 && !this.args; }
  MetapostExpr.prototype.isOne = function(p) { return this.func == 1 && !this.args; }
  MetapostExpr.prototype.isPrimitive = function() { return this.args == null; }
  MetapostExpr.prototype.isPrimitiveNumber = function() { return this.isPrimitive() && sfig.isNumber(this.func); }

  MetapostExpr.prototype.getPrimitiveNumber = function() {
    if (!this.isPrimitiveNumber()) throw 'Not primitive number: ' + this;
    return this.func;
  }

  MetapostExpr.prototype.simpleEquals = function(p) {
    p = MetapostExpr.ensureNumeric(p);
    return !this.args && !p.args && this.func == p.func;
  }

  // Numerical operations
  MetapostExpr.prototype.negate = function() {
    if (this.type == 'numeric' && sfig.isNumber(this.func)) return MetapostExpr.numeric(-this.func);
    return new MetapostExpr(this.type, '-', [this]);
  }
  MetapostExpr.prototype.add = function(p) {
    p = MetapostExpr.ensureNumeric(p);
    if (this.isZero()) return p;
    if (p.isZero()) return this;
    if (this.isPrimitiveNumber() && p.isPrimitiveNumber()) return MetapostExpr.numeric(this.func + p.func);
    return new MetapostExpr(this.type, '+', [this, p]);
  }
  MetapostExpr.prototype.sub = function(p) {
    p = MetapostExpr.ensureNumeric(p);
    if (p.isZero()) return this;
    if (this.simpleEquals(p)) return MetapostExpr.zero;
    if (this.isPrimitiveNumber() && p.isPrimitiveNumber()) return MetapostExpr.numeric(this.func - p.func);
    return new MetapostExpr(this.type, '-', [this, p]);
  }
  MetapostExpr.prototype.up = sfig.downSign == 1 ? MetapostExpr.prototype.sub : MetapostExpr.prototype.add;
  MetapostExpr.prototype.down = sfig.downSign == 1 ? MetapostExpr.prototype.add : MetapostExpr.prototype.sub;
  MetapostExpr.prototype.mul = function(p) {
    p = MetapostExpr.ensureNumeric(p);
    if (this.isZero() || p.isZero()) return MetapostExpr.zero;
    if (this.isOne()) return p;
    if (p.isOne()) return this;
    if (this.isPrimitiveNumber() && p.isPrimitiveNumber()) return MetapostExpr.numeric(this.func * p.func);
    return new MetapostExpr(this.type, '*', [this, p]);
  }
  MetapostExpr.prototype.div = function(p) {
    p = MetapostExpr.ensureNumeric(p);
    if (this.isZero()) return this;
    if (p.isOne()) return this;
    if (this.isPrimitiveNumber() && p.isPrimitiveNumber()) return MetapostExpr.numeric(this.func / p.func);
    return new MetapostExpr(this.type, '/', [this, p]);
  }
  MetapostExpr.prototype.min = function(p) {
    if (this.simpleEquals(p)) return this;
    if (this.isPrimitiveNumber() && p.isPrimitiveNumber()) return MetapostExpr.numeric(Math.min(this.func, p.func));
    return new MetapostExpr(this.type, 'min', [this, p]);
  }
  MetapostExpr.prototype.max = function(p) {
    if (this.simpleEquals(p)) return this;
    if (this.isPrimitiveNumber() && p.isPrimitiveNumber()) return MetapostExpr.numeric(Math.max(this.func, p.func));
    return new MetapostExpr(this.type, 'max', [this, p]);
  }
  MetapostExpr.prototype.abs = function() { return new MetapostExpr(this.type, 'abs', [this]); }

  MetapostExpr.prototype.bbox = function() { return new MetapostExpr('path', 'mybbox', [this]); }
  MetapostExpr.prototype.center = function() { return new MetapostExpr('pair', 'center', [this]); }
  MetapostExpr.prototype.reverse = function() { return new MetapostExpr('path', 'reverse', [this]); }

  // Properties
  MetapostExpr.prototype.left = function() { return new MetapostExpr('numeric', 'L', [this]); }
  MetapostExpr.prototype.top = function() { return new MetapostExpr('numeric', 'T', [this]); }
  MetapostExpr.prototype.right = function() { return new MetapostExpr('numeric', 'R', [this]); }
  MetapostExpr.prototype.bottom = function() { return new MetapostExpr('numeric', 'B', [this]); }
  MetapostExpr.prototype.realWidth = function() { return new MetapostExpr('numeric', 'W', [this]); }
  MetapostExpr.prototype.realHeight = function() { return new MetapostExpr('numeric', 'H', [this]); }

  // http://www.w3schools.com/tags/ref_color_tryit.asp
  MetapostExpr.colorMap = {
    white: '#FFFFFF',
    black: '#000000',
    silver: '#C0C0C0',
    gray: '#808080',
    lightgray: '#D3D3D3',
    darkgray: '#A9A9A9',

    red: '#FF0000',
    blue: '#0000FF',
    green: '#008000',

    darkblue: '#0000A0',
    lightblue: '#ADD8E6',
    cyan: '#00FFFF',
    orange: '#FFA500',
    purple: '#800080',
    brown: '#A52A2A',
    yellow: '#FFFF00',
    maroon: '#800000',
    lime: '#00FF00',
    fuchsia: '#FF00FF',
    olive: '#808000',
    pink: '#FAAFBE',
  };
  for (var color in MetapostExpr.colorMap)
    MetapostExpr.colorMap[color] = MetapostExpr.hexcolor(MetapostExpr.colorMap[color]);
  MetapostExpr.ensureColor = function(color) {
    if (color instanceof MetapostExpr) return color;
    if (color in MetapostExpr.colorMap) return MetapostExpr.colorMap[color];
    throw 'Unknown color: ' + color;
  }

  // Transformations of picture
  MetapostExpr.prototype.color = function(color) { return new MetapostExpr('picture', 'image(draw '+this+ ' withcolor '+MetapostExpr.ensureColor(color)+')'); }
  MetapostExpr.prototype.xadd = function(xshift) { return new MetapostExpr(this.type, 'xshifted', [this, xshift]); }
  MetapostExpr.prototype.yadd = function(yshift) { return new MetapostExpr(this.type, 'yshifted', [this, yshift]); }
  MetapostExpr.prototype.ydown = function(yshift) { return new MetapostExpr(this.type, 'yshifted', [this, MetapostExpr.ensureNumeric(yshift).negate()]); }
  MetapostExpr.prototype.xscale = function(xscale) { return new MetapostExpr(this.type, 'xscaled', [this, xscale]); }
  MetapostExpr.prototype.yscale = function(yscale) { return new MetapostExpr(this.type, 'yscaled', [this, yscale]); }
  MetapostExpr.prototype.rotate = function(rotate) { return new MetapostExpr(this.type, 'rotated', [this, MetapostExpr.ensureNumeric(rotate).negate()]); }

  MetapostExpr.prototype.assertType = function(type) { if (this.type != type) throw 'Expected type ' + type + ', but got type ' + this.type + '; value is ' + this; }
  MetapostExpr.prototype.assertPair = function() { this.assertType('pair'); }

  MetapostExpr.prototype.x = function() {
    this.assertPair();
    if (this.children) return Value.numeric(this.children[0]);
    else return new MetapostExpr('numeric', 'xpart', [this]);
  }
  MetapostExpr.prototype.y = function() {
    this.assertPair();
    if (this.children) return Value.numeric(this.children[1]);
    else return new MetapostExpr('numeric', 'ypart', [this]);
  }

  MetapostExpr.text = function(str, useRawBounds, fontSize) {
    var h = useRawBounds ? '' : '; hackTextBounds';
    var data = 'image(draw btex '+str+' etex'+h+') scaled ' + (fontSize / 10.0);
    return MetapostExpr.picture(data);
  }

  var drawFuncs = {draw:1, fill:1, drawarrow:1, drawdblarrow:1};
  var infixFuncs = {intersectionpoint:1, xscaled:1, yscaled:1, xshifted:1, yshifted:1, rotated:1, intersectionpoint:1};
  MetapostExpr.prototype.toString = function() {
    if (!this.args) {
      if (sfig.isNumber(this.func)) return parseFloat(this.func.toFixed(5));  // Round (Metapost can't handle scientific notation 1e-7)
      return this.func;
    }
    if (this.func == 'pair' || this.func == 'color') return '(' + this.args.join(',') + ')';
    if (this.func == 'path') return '(' + this.args.join('') + ')';
    //if (this.func in drawFuncs) return '(' + this.func + ' ' + this.args.join(' ') + ')';
    if (this.func in drawFuncs) return this.func + ' ' + this.args.join(' ');
    if (this.func == '-' && this.args.length == 1)
      return '(-' + this.args[0] + ')';
    if (this.func in infixFuncs)
      return '(' + this.args[0] + ' ' + this.func + ' ' + this.args[1] + ')';
    if (this.func == '+' || this.func == '-' || this.func == '*' || this.func == '/')  // Infix
      return '(' + this.args[0] + this.func + this.args[1] + ')';
    return this.func + '(' + this.args.join(',') + ')'; // Standard form for function
  };

  // Override behavior to work with MetapostExpr
  var Thunk = sfig.Thunk;
  Thunk.add = function(a, b) { return a == null || b == null ? null : MetapostExpr.ensureNumeric(a).add(b); }
  Thunk.sub = function(a, b) { return a == null || b == null ? null : MetapostExpr.ensureNumeric(a).sub(b); }
  Thunk.mul = function(a, b) { return a == null || b == null ? null : MetapostExpr.ensureNumeric(a).mul(b); }
  Thunk.div = function(a, b) { return a == null || b == null ? null : MetapostExpr.ensureNumeric(a).div(b); }
  Thunk.min = function(a, b) { return a == null || b == null ? null : MetapostExpr.ensureNumeric(a).min(b); }
  Thunk.max = function(a, b) { return a == null || b == null ? null : MetapostExpr.ensureNumeric(a).max(b); }

  Thunk.addHalf = function(a, b) { return a == null || b == null ? null : MetapostExpr.ensureNumeric(a).add(MetapostExpr.ensureNumeric(b).div(2)); }
  Thunk.up = function(a, b) { return a == null || b == null ? null : (sfig.downSign == 1 ? MetapostExpr.ensureNumeric(a).sub(b) : MetapostExpr.ensureNumeric(a).add(b)); }
  Thunk.down = function(a, b) { return a == null || b == null ? null : (sfig.downSign == 1 ? MetapostExpr.ensureNumeric(a).add(b) : MetapostExpr.ensureNumeric(a).sub(b)); }
  Thunk.downHalf = function(a, b) { return a == null || b == null ? null : MetapostExpr.ensureNumeric(a).down(MetapostExpr.ensureNumeric(b).div(2)); }

  // Important: need to change addition to substraction for y coordinate.
  var Block = sfig.Block;
  sfig_.removeProperty(Block, 'right');
  sfig_.removeProperty(Block, 'bottom');
  sfig_.removeProperty(Block, 'xmiddle');
  sfig_.removeProperty(Block, 'ymiddle');
  sfig_.addDerivedProperty(Block, 'right', sfig.Thunk.add, ['left', 'realWidth'], 'Right coordinate');
  sfig_.addDerivedProperty(Block, 'bottom', sfig.Thunk.down, ['top', 'realHeight'], 'Bottom coordinate');
  sfig_.addDerivedProperty(Block, 'xmiddle', sfig.Thunk.addHalf, ['left', 'realWidth'], 'Middle x-coordinate');
  sfig_.addDerivedProperty(Block, 'ymiddle', sfig.Thunk.downHalf, ['top', 'realHeight'], 'Middle y-coordinate');

  // Override
  sfig.nil = function() { return sfig.circle(0); }
})();

(function() {
  // Look at all the properties and children and create the SVG elem property.
  // Default: just collect children into a single group.
  sfig.Block.prototype.drawMetapost = function(writer) {
    var pic = writer.store(sfig.MetapostExpr.nullpicture);
    this.children.forEach(function(block) {
      if (block.pic == null) throw 'No pic for '+block;
      writer.addToPicture(pic, block.pic);
    });
    this.pic = pic;
  }

  sfig.Block.prototype.drawPicture = function(state, writer) {
    if (this.pic != null) return; // Already drawn

    // Recursively draw children
    if (!isLeaf(this)) {
      this.initDependencies.forEach(function(block) { block.drawPicture(state, writer); });  // Do these first
      this.children.forEach(function(block) { block.drawPicture(state, writer); });
    }

    this.drawMetapost(writer);
    if (this.pic == null) throw 'pic not set by drawMetapost: ' + this;

    // Unlike in SVG, which has a transform tag, we have to go in and manually
    // transform each child.

    // Set the current bounds
    this.left(this.pic.left());
    this.top(this.pic.top());
    this.realWidth(this.pic.realWidth());
    this.realHeight(this.pic.realHeight());

    // Apply properties (mirrors applyTransforms)
    var strokeColor = this.strokeColor().get();
    var xshift = writer.storeIfComplex(this.xshift().getOrElse(0));
    var yshift = writer.storeIfComplex(this.yshift().getOrElse(0));
    var xscale = writer.storeIfComplex(this.xscale().getOrElse(1));
    var yscale = writer.storeIfComplex(this.yscale().getOrElse(1));
    var rotate = writer.storeIfComplex(this.rotate().getOrElse(0));

    function applyTransforms(block) {
      // For circles and rectangles, there is one picture that contains both
      // the stroke and fill parts.  Unfortunately, we can't separate them out
      // right now.  So don't apply the stroke color if block is filled.
      // Hack: don't apply to blocks that have fill colors.
      if (strokeColor != null && !block.fillColor().exists())
        writer.set(block.pic, block.pic.color(strokeColor));

      // TODO: apply other properties recursively like strokeWidth, but have to look inside pic

      if (xscale != 1) writer.set(block.pic, block.pic.xscale(xscale));
      if (yscale != 1) writer.set(block.pic, block.pic.yscale(yscale));

      if (xshift != 0) writer.set(block.pic, block.pic.xadd(xshift));
      if (yshift != 0) writer.set(block.pic, block.pic.yadd(yshift));

      // Pivoting around a point not supported right now, use rotatedaround in the future?
      if (rotate != 0) writer.set(block.pic, block.pic.rotate(rotate));

      if (!isLeaf(block))
        block.children.forEach(applyTransforms);
    }
    applyTransforms(this);
  }

  // Based off Text.bulletize()
  bulletizeLatex = function(content) {
    if (content instanceof Array) {
      var result = [];
      if (content[0]) result.push(content[0]);
      var result = [];
      result.push('\\begin{itemize}');
      result.push('\\setlength{\\itemsep}{0pt}');
      for (var i = 1; i < content.length; i++) {
        result.push('\\item ' + bulletizeLatex(content[i]));
      }
      result.push('\\end{itemize}');
      return result.join("\n");
    }
    return content;
  }

  function computeAutowrap(text) {
  }

  sfig.Text.prototype.drawMetapost = function(writer) {
    var content = this.content().get();

    // Put bullets.
    if (this.bulleted().get()) {
      if (sfig.isString(content)) content = [null, content];
      // Convert from width allowed for the text and inches
      // Note: in SVG, width() is an upper bound on how much space we'll take.
      // Here, we will actually use up all of width because of minipage.
      // We must use minipage for itemize, but also allows us to do wrapping.
      content = bulletizeLatex(content);
    }

    var strippedContent = content.replace(/<[^>]+>/g, '');

    // Replace HTML tags with LaTeX markup
    // This is inefficient.
    // Metapost: doesn't seem to support both italics and bold, whereas normal Latex does.
    while (true) {
      var oldContent = content;
      content = content.replace(/<b>([^<]+)<\/b>/g, '\\textbf{$1}');
      content = content.replace(/<i>([^<]*)<\/i>/g, '\\textit{$1}');
      content = content.replace(/<tt>([^<]*)<\/tt>/g, '\\texttt{$1}');
      content = content.replace(/<font color="([^>]+)">([^<]*)<\/font>/g, '\\textcolor{$1}{$2}');
      if (oldContent == content) break;
    }

    // Convert HTML to LaTeX (somewhat dangerous)
    content = content.replace(/%/g, '\\%');
    content = content.replace(/&ndash;/g, '--');
    content = content.replace(/&mdash;/g, '---');
    content = content.replace(/&amp;/g, '\\&');
    // Quote these things outside math mode
    //content = content.replace(/_/g, '\\_');
    content = content.replace(/&/g, '\\&');
    content = content.replace(/#/g, '\\#');
    //sfig.L(content);

    // In Metapost, wrapping means we have to put things in a minipage, which
    // means (unlike SVG) it takes up the entire allotted width.
    var autowrap = this.bulleted().get() || this.autowrap().get();
    if (autowrap == null) {
      // Try to guess what is the appropriate behavior here.
      // For short strings, don't autowrap.  For long ones, do.
      autowrap = strippedContent.length > 64;
    }
    //L(strippedContent + ': ' + autowrap);
    if (autowrap) {
      var width = this.width().getOrDie() / 210;  // Hack: need to find right ratio
      //L(content + ': ' + this.width().get());
      content = '\\begin{minipage}{'+width+'in}\n' + content + '\n\\end{minipage}';
    }

    var pic = writer.store(sfig.MetapostExpr.text(content, false, this.fontSize().getOrDie()));
    this.pic = writer.store(pic.ydown(pic.realHeight()));

    if (autowrap && !this.bulleted().get()) {
      // Hack: extra space for minipages
      var extra = 6;
      var left = this.pic.left();
      var top = this.pic.top().up(extra);
      var right = this.pic.right();
      var bottom = this.pic.bottom().down(extra);
      writer.setBounds(this.pic, sfig.MetapostExpr.rect(left, top, right, bottom));
    }
  }

  function getDrawOptions(block) {
    var opts = [];

    // Handle color/opacity
    var strokeColor = block.strokeColor().getOrElse('black');
    var strokeOpacity = block.strokeOpacity().getOrElse(1);
    if (strokeColor != 'black' || strokeOpacity != 1) {
      if (strokeOpacity == 1)
        opts.push('withcolor ' + sfig.MetapostExpr.ensureColor(strokeColor));
      else
        opts.push('withcolor transparent(1,' + strokeOpacity + ',' + sfig.MetapostExpr.ensureColor(strokeColor)+')');
    }

    // Handle stroke width
    var strokeWidth = block.strokeWidth().getOrElse(sfig.defaultStrokeWidth);
    if (strokeWidth == 0 || block instanceof sfig.Image) opts.push('withcolor transparent(1,0,black)');  // Make transparent to simulate invisible stroke
    if (strokeWidth != 1) opts.push('withpen pencircle scaled ' + strokeWidth);

    // FUTURE: handle general case - right now, only have dots and dashes
    var strokeDasharray = block.strokeDasharray().get();
    if (strokeDasharray != null) {
      if (strokeDasharray[0] > strokeDasharray[1])
        opts.push('dashed evenly');
      else
        opts.push('dashed withdots');
    }
    return opts;
  }

  function getFillOptions(block) {
    var opts = [];

    // Handle color/opacity
    var fillColor = block.fillColor().getOrElse('black');
    var fillOpacity = block.fillOpacity().getOrElse(1);
    if (fillColor != 'black' || fillOpacity != 1) {
      if (fillOpacity == 1)
        opts.push('withcolor ' + sfig.MetapostExpr.ensureColor(fillColor));
      else
        opts.push('withcolor transparent(1,' + fillOpacity + ',' + sfig.MetapostExpr.ensureColor(fillColor)+')');
    }
    return opts;
  }

  sfig.Block.prototype.drawPath = function(writer, path) {
    this.path = path = writer.storeIfComplex(path);
    var strokeColor = this.strokeColor().get();
    var fillColor = this.fillColor().get();

    if (this instanceof sfig.DecoratedLine) {
      var d1 = this.drawArrow1().get();
      var d2 = this.drawArrow2().get();
      // Simplification: if both ends have arrow heads, use single arrow size.
      var length, width;
      if (d1) {
        length = this.arrowHead1.length().get();
        width = this.arrowHead1.width().get();
      } else if (d2) {
        length = this.arrowHead2.length().get();
        width = this.arrowHead2.width().get();
      }
      if (d1 || d2) {
        writer.set(sfig.MetapostExpr.numeric('ahlength'), length);
        writer.set(sfig.MetapostExpr.numeric('ahangle'), sfig_.atan2Degrees(width, length));
      }

      if (d1 && d2)
        this.pic = writer.store(sfig.MetapostExpr.drawdblarrow(path, getDrawOptions(this)));
      else if (d1)
        this.pic = writer.store(sfig.MetapostExpr.drawarrow(path.reverse(), getDrawOptions(this)));
      else if (d2)
        this.pic = writer.store(sfig.MetapostExpr.drawarrow(path, getDrawOptions(this)));
      else  // No arrow
        this.pic = writer.store(sfig.MetapostExpr.draw(path, getDrawOptions(this)));
      return;
    }
    
    // Lines don't have fill, so don't try (otherwise will crash Metapost).
    if (fillColor == null || this instanceof sfig.Line) {
      // Need to draw stroke, not fill.
      this.pic = writer.store(sfig.MetapostExpr.draw(path, getDrawOptions(this)));
    } else {
      // Both are specified and have different colors.
      var pic = writer.store(sfig.MetapostExpr.nullpicture);
      writer.addToPicture(pic, sfig.MetapostExpr.fill(path, getFillOptions(this)));
      writer.addToPicture(pic, sfig.MetapostExpr.draw(path, getDrawOptions(this)));
      this.pic = pic;
    }
  }

  function createLinePath(writer, block) {
    // Get positions
    var x1, y1, x2, y2;
    if (block.b1().get() != null) {
      x1 = block.b1().get().xmiddle().getOrDie();
      y1 = block.b1().get().ymiddle().getOrDie();
    } else {
      x1 = block.x1().getOrDie();
      y1 = block.y1().getOrDie();
    }

    if (block.b2().get() != null) {
      x2 = block.b2().get().xmiddle().getOrDie();
      y2 = block.b2().get().ymiddle().getOrDie();
    } else {
      x2 = block.x2().getOrDie();
      y2 = block.y2().getOrDie();
    }

    var p1 = [x1, y1];
    var p2 = [x2, y2];
    var sep = block.curved ? '..' : '--';
    var path = sfig.MetapostExpr.path([p1, sep, p2]);

    function getBoundingPath(block) {
      // Analogous to clipPoint().
      if (block.path != null) {
        // Take the path and shift it into the right place
        // Take the difference between the current position (block.pic) and the original (origPic)
        var origPic = sfig.MetapostExpr.draw(block.path);
        var offset = writer.store(block.pic.center().sub(origPic.center()));
        return writer.store(block.path.xadd(offset.x()).yadd(offset.y()));
      }
      var c;
      for (var i = 0; i < block.children.length; i++) {
        if (block.children[i].orphan().get()) continue;
        if (c == null) c = i;
        else { c = null; break; }
      }
      if (c != null) return getBoundingPath(block.children[c]);
      return block.pic.bbox();
    }

    // Clip the endpoints
    if (block.b1().get() != null) {
      path = writer.storeIfComplex(path);
      p1 = sfig.MetapostExpr.intersectionpoint(path, getBoundingPath(block.b1().get()));
    }
    if (block.b2().get() != null) {
      path = writer.storeIfComplex(path);
      p2 = sfig.MetapostExpr.intersectionpoint(path, getBoundingPath(block.b2().get()));
    }
    path = sfig.MetapostExpr.path([p1, sep, p2]);
    return path;
  }

  sfig.Line.prototype.drawMetapost = function(writer) {
    var path = createLinePath(writer, this);
    this.drawPath(writer, path);
  }

  sfig.DecoratedLine.prototype.drawMetapost = function(writer) {
    var path = createLinePath(writer, this.line);
    this.drawPath(writer, path);
  }

  sfig.Ellipse.prototype.drawMetapost = function(writer) {
    var path = sfig.MetapostExpr.path(['fullcircle']);
    var xradius = this.xradius().getOrDie();
    path = path.xscale(xradius*2);
    var yradius = this.yradius().getOrDie();
    path = path.yscale(yradius*2);
    this.drawPath(writer, path);
  }

  sfig.Poly.prototype.drawMetapost = function(writer) {
    var args = [];
    this.getPoints().forEach(function(p) {
      if (args.length > 0) args.push('--');
      args.push(p);
    });
    if (this.closed().get()) args.push('--cycle');
    var path = sfig.MetapostExpr.path(args);
    this.drawPath(writer, path);
  }

  sfig.Rect.prototype.drawMetapost = function(writer) {
    var E = sfig.MetapostExpr.ensureNumeric;
    var rx = E(this.xround().getOrElse(0));
    var ry = E(this.yround().getOrElse(0));
    var x = E(this.width().getOrDie());
    var y = E(this.height().getOrDie()).negate();

    var path = null;
    if (rx != 0 && ry != 0) {  // Rounded corners
      path = sfig.MetapostExpr.path([
        [0, sfig.down(ry)], '--',
        [0, y.up(ry)], '{down}..',
        [rx, y], '--',
        [x.sub(rx), y], '{right}..',
        [x, y.up(ry)], '--',
        [x, sfig.down(ry)], '{up}..',
        [x.sub(rx), 0], '--',
        [rx, 0], '{left}..cycle',
      ]);
    } else {
      path = sfig.MetapostExpr.path([
        [0, 0], '--',
        [0, y], '--',
        [x, y], '--',
        [x, 0], '--cycle',
      ]);
    }

    this.drawPath(writer, path);
  }

  // For images, just draw the bounding box as a place holder.
  // The actual image will be inserted into the right place later.
  sfig.Image.prototype.drawMetapost = function(writer) {
    var E = sfig.MetapostExpr.ensureNumeric;
    // Read the dimensions from the file
    // Note: make sure ./compute-all-image-sizes.rb is run first.
    // Future: compute image sizes in node.js.
    var path = this.href().getOrDie();
    var info = JSON.parse(fs.readFileSync(path + '.info'));
    if (info.type != 'PNG' && info.type != 'JPEG')
      throw path + ' has unsupported image format: ' + info.type;
    var dim = this.computeDesiredDim(info.width, info.height);
    var x = E(dim[0]);
    var y = E(dim[1]).negate();
    var path = sfig.MetapostExpr.path([
      [0, 0], '--',
      [0, y], '--',
      [x, y], '--',
      [x, 0], '--cycle',
    ]);
    this.drawPath(writer, path);
  }

  sfig.Table.prototype.drawMetapost = function(writer) {
    var E = sfig.MetapostExpr.ensureNumeric;
    // Based on renderElem(): need to work with MetapostExpr instead of actual numbers
    // Justification
    var xjustify = this.xjustify().getOrElse('l');
    while (xjustify.length < this.numCols) xjustify += xjustify[xjustify.length-1];
    var yjustify = this.yjustify().getOrElse('l');
    while (yjustify.length < this.numRows) yjustify += yjustify[yjustify.length-1];

    // Compute maximum width of each column and height of each column
    var widths = [];
    var heights = [];
    var cellWidth = E(this.cellWidth().getOrElse(0));
    var cellHeight = E(this.cellHeight().getOrElse(0));
    for (var r = 0; r < this.numCols; r++) widths.push(writer.store(cellWidth));
    for (var c = 0; c < this.numRows; c++) heights.push(writer.store(cellHeight));
    for (var r = 0; r < this.numRows; r++) {
      for (var c = 0; c < this.numCols; c++) {
        writer.setMax(widths[c], this.cells[r][c].realWidth().get());
        writer.setMax(heights[r], this.cells[r][c].realHeight().get());
      }
    }

    var xmargin = E(this.xmargin().getOrElse(0));
    var ymargin = E(this.ymargin().getOrElse(0));

    // If desire a different width/height, change the widths/heights
    // by shrinking the excess.
    var totalWidth = writer.store(E(0));
    if (this.numCols > 0) {
      writer.increment(totalWidth, xmargin.mul(this.numCols - 1));
      for (var c = 0; c < this.numCols; c++) writer.increment(totalWidth, widths[c]);
      var extraWidth = E(this.width().getOrElse(totalWidth)).sub(totalWidth).div(this.numCols).max(0);
      for (var c = 0; c < this.numCols; c++) writer.increment(widths[c], extraWidth);
      writer.increment(totalWidth, extraWidth);
    }

    var totalHeight = writer.store(E(0));
    if (this.numRows > 0) {
      writer.increment(totalHeight, ymargin.mul(this.numRows - 1));
      for (var r = 0; r < this.numRows; r++) writer.increment(totalHeight, heights[r]);
      var extraHeight = E(this.height().getOrElse(totalHeight)).sub(totalHeight).div(this.numRows).max(0);
      for (var r = 0; r < this.numRows; r++) writer.increment(heights[r], extraHeight);
      writer.increment(totalHeight, extraHeight);
    }

    // Starting positions
    var xstart = [E(0)];
    var ystart = [E(0)];
    for (var c = 1; c <= this.numCols; c++)
      xstart[c] = writer.store(xstart[c-1].add(widths[c-1]).add(c < this.numCols ? xmargin : 0));
    for (var r = 1; r <= this.numRows; r++)
      ystart[r] = writer.store(ystart[r-1].down(heights[r-1]).down(r < this.numRows ? ymargin : 0));

    function justifyToPivot(justify) {
      if (justify == 'l') return -1;
      if (justify == 'c') return 0;
      if (justify == 'r') return +1;
      throw 'Invalid justify (expected l,c,r): '+justify;
    }

    // To compute the bounding box (if there are orphan children)
    var left = writer.store(totalWidth);
    var top = writer.store(totalHeight.negate());
    var right = writer.store(E(0));
    var bottom = writer.store(E(0));

    // Display the table
    this.pic = writer.store(sfig.MetapostExpr.nullpicture);
    for (var r = 0; r < this.numRows; r++) {
      for (var c = 0; c < this.numCols; c++) {
        var cell = this.cells[r][c];

        // Compute the offset
        var xpivot = cell.xparentPivot().getOrElse(justifyToPivot(xjustify[c]));
        var ypivot = cell.yparentPivot().getOrElse(justifyToPivot(yjustify[r]));
        var xoffset = xstart[c].add(widths[c].mul(0.5 * (xpivot + 1))).sub(
                      cell.left().getOrDie().add(cell.realWidth().getOrDie().mul(0.5 * (xpivot + 1))));
        var yoffset = ystart[r].down(heights[r].mul(0.5 * (ypivot + 1))).sub(
                      cell.top().getOrDie().down(cell.realHeight().getOrDie().mul(0.5 * (ypivot + 1))));

        // Only non-orphans contribute to the bounding box
        if (!cell.orphan().get()) {
          writer.setMin(left, xstart[c]);
          writer.setMax(top, ystart[r]);
          writer.setMax(right, xstart[c+1]);
          writer.setMin(bottom, ystart[r+1]);
        }

        // Shift the cell element (remember to do it recursively)
        recursiveOffset(cell, xoffset, yoffset);
        function recursiveOffset(block) {
          if (!isLeaf(block)) block.children.forEach(recursiveOffset);
          writer.set(block.pic, block.pic.xadd(xoffset).yadd(yoffset));
        }
        recursiveOffset(cell);
        writer.addToPicture(this.pic, cell.pic);
      }
    }

    writer.setBounds(this.pic, sfig.MetapostExpr.rect(left, top, right, bottom));
  }
})();

(function() {
  function MetapostWriter() {
    this.output = [];  // Lines to output

    var font = sfig.Text.defaults.getProperty('font').getOrDie();
    var family = null;
    if (font == 'Times New Roman') {
      family = '\\rmdefault';
    } else if (font == 'Noto Sans' || font == 'Arial') {
      family = '\\sfdefault';
    } else {
      throw 'Unknown font: ' + font;
    }

    this.prefixes = { numeric: "n", pair: "r", path: "h", picture: "p", color: "c" };
    this.varCounts = {}  // Indices for variables
    this.numPages = 0;

    this.verbatimTex(
      '%&latex',
      '\\documentclass{article}',
      '\\usepackage{color,amsmath,amssymb,ulem,verbatim,ifthen}',
      '\\renewcommand{\\familydefault}{'+family+'}');

    this.verbatimTex.apply(this, Object.keys(sfig.MetapostExpr.colorMap).map(function(color) {
      var rgb = sfig.MetapostExpr.colorMap[color];
      return '\\definecolor{' + color + '}{rgb}{' + rgb.args.join(',') + '}';
    }));
    
    // Include macros
    var lines = [];
    for (var name in sfig_.latexMacros) {
      var arityBody = sfig_.latexMacros[name];
      lines.push('\\providecommand{\\'+name+'}['+arityBody[0]+']{'+arityBody[1]+'}');
    }
    this.verbatimTex.apply(this, lines);

    this.verbatimTex('\\begin{document}');

    // Define L(eft), T(op), W(idth), H(eight)
    this.verbatim(
      'vardef L(expr p) = xpart(ulcorner p) enddef;',
      'vardef R(expr p) = xpart(urcorner p) enddef;',
      'vardef T(expr p) = ypart(ulcorner p) enddef;',
      'vardef B(expr p) = ypart(llcorner p) enddef;',
      'vardef W(expr p) = xpart(urcorner p) - xpart(ulcorner p) enddef;',
      'vardef H(expr p) = ypart(urcorner p) - ypart(lrcorner p) enddef;',
      'vardef mybbox(expr p) = (ulcorner p--urcorner p--lrcorner p--llcorner p--cycle) enddef;', // Tighter than bbox
      '',
      // Change bounds to include potential ascenders and descenders
      // Note: multiply by some fudge factors to make the spacing more like SVG rather than rfig.
      'textyl := ypart lrcorner image(draw btex g etex) * 2;',
      'textyu := ypart urcorner image(draw btex l etex) * 1.5;',
      // Make arrows sharp
      'linejoin := mitered;',
      'linecap := butt;',
      'def hackTextBounds =',
      '  setbounds currentpicture to ((xpart llcorner currentpicture), min(ypart llcorner currentpicture, textyl))--',
      '                              ((xpart lrcorner currentpicture), min(ypart lrcorner currentpicture, textyl))--',
      '                              ((xpart urcorner currentpicture), max(ypart urcorner currentpicture, textyu))--',
      '                              ((xpart ulcorner currentpicture), max(ypart ulcorner currentpicture, textyu))--',
      '                              cycle;',
      'enddef;');

    for (var k in this.prefixes)
      this.verbatim(k + ' ' + this.prefixes[k] + '[];');
  }

  MetapostWriter.prototype.finish = function(outPath) {
    this.verbatim('end;');
    fs.writeFileSync(outPath, this.output.join("\n") + "\n");
  }

  MetapostWriter.prototype.verbatimTex = function() {
    this.output.push('verbatimtex');
    for (var i = 0; i < arguments.length; i++)
      this.output.push(arguments[i]);
    this.output.push('etex');
  }
  MetapostWriter.prototype.verbatim = function() {
    for (var i = 0; i < arguments.length; i++)
      this.output.push(arguments[i]);
  }

  MetapostWriter.prototype.setMin = function(v, val) { this.set(v, v.min(val)); }
  MetapostWriter.prototype.setMax = function(v, val) { this.set(v, v.max(val)); }
  MetapostWriter.prototype.increment = function(v, val) { this.set(v, v.add(val)); }
  MetapostWriter.prototype.set = function(v, val) {
    if (v.simpleEquals(val)) return;  // No-op
    this.output.push(v + ' := ' + val + ';');
  }
  MetapostWriter.prototype.store = function(val) {
    var id = (this.varCounts[val.type] || 0) + 1;
    this.varCounts[val.type] = id;
    var v = new sfig.MetapostExpr(val.type, this.prefixes[val.type] + id);
    this.set(v, val);
    return v;
  }
  MetapostWriter.prototype.storeIfComplex = function(val) {
    // Complex means has arguments
    if (val.args) return this.store(val);
    return val;
  }
  MetapostWriter.prototype.comment = function(str) {
    this.verbatim('% ' + str);
  }

  MetapostWriter.prototype.addToPicture = function(targetPic, srcPic) {
    this.verbatim('addto ' + targetPic + ' also ' + srcPic + ';');
  }

  MetapostWriter.prototype.setBounds = function(pic, rect) {
    this.verbatim('setbounds ' + pic + ' to ' + rect + ';');
  }

  MetapostWriter.prototype.makeFigure = function(activeBlocks) {
    var self = this;
    this.verbatim('beginfig(' + this.numPages + ');');
    this.numPages++;
    activeBlocks.forEach(function(block) {
      var pic = block.pic;

      // Print out image separately
      if (block instanceof sfig.Image) {
        self.verbatim('draw ' + pic + ';');
        var file = Path.resolve(block.href().get());
        if (!Path.existsSync(file))
          throw 'File does not exist: ' + file;
        self.verbatim([
          'externalfigure',
          '"'+file+'"',
          'xyscaled', self.store(sfig.MetapostExpr.xypair(pic.realWidth(), pic.realHeight())),
          'shifted', self.store(sfig.MetapostExpr.xypair(pic.left(), pic.top().down(pic.realHeight()))),
        ].join(' ') + ';');
      } else {
        self.verbatim('draw ' + pic + ';');
      }
    });
    this.verbatim('endfig;');
  };

  // outPath: Metapost file
  function createMetapost(slide, outPath) {
    var oldContents = Path.existsSync(outPath) ? fs.readFileSync(outPath) : '';

    // Create the Metapost file
    var writer = new MetapostWriter();
    slide.drawPicture(slide.state, writer);

    // Go through all the leaves under |block|
    // and add the ones which are active at level.
    var E = sfig.MetapostExpr.ensureNumeric;
    var maxLevel = 0;
    // |block| is added to |blocks| for level |currLevel| if
    // the intersection of all [showLevel, hideLevel] intervals of its
    // ancestors contains level.
    // showLevel and hideLevel: constraints imposed by answers of |block|.
    // Along the way, update |maxLevel|.
    function getLeaves(block, currLevel, ancestralShowLevel, ancestralHideLevel, blocks) {
      // Add block to blocks if showLevel <= level < hideLevel
      // (if showLevel and hideLevel exist)
      var showLevel = block.showLevel().get();
      var hideLevel = block.hideLevel().get();
      //sfig.L(block + ' ' + showLevel + ' ' + hideLevel);
      if (showLevel != null) {
        showLevel = E(showLevel).getPrimitiveNumber();
        maxLevel = Math.max(maxLevel, showLevel);
        if (showLevel != -1 && showLevel > currLevel) return;
        ancestralShowLevel = Math.max(ancestralShowLevel, showLevel);
      }
      if (hideLevel != null) {
        hideLevel = E(hideLevel).getPrimitiveNumber();
        maxLevel = Math.max(maxLevel, hideLevel);
        if (hideLevel != -1 && hideLevel <= currLevel) return;
        ancestralHideLevel = Math.min(ancestralHideLevel, hideLevel);
      }
      if (isLeaf(block)) {
        blocks.push(block);
      } else {
        block.children.forEach(function(child) { getLeaves(child, currLevel, ancestralShowLevel, ancestralHideLevel, blocks); });
      }
    }

    for (var level = 0; level <= maxLevel; level++) {
      var activeBlocks = [];
      getLeaves(slide, level, 0, 1000000, activeBlocks);
      //sfig.L('======== ' + activeBlocks.join(' ; '));
      writer.makeFigure(activeBlocks);
    }

    writer.finish(outPath);

    var newContents = fs.readFileSync(outPath);

    // Check to see if the Metapost file changed.
    if (oldContents.toString() != newContents.toString() || !Path.existsSync(outPath.replace(/\.mp$/, '.pdf'))) {
      // Convert Metapost to PDF
      sfig_.queue.system(__dirname + '/../bin/mpto1pdf -quiet \'' + outPath + '\'');
    }
  }

  function Queue() {
    this.tasks = [];
    this.exec = require('child_process').exec;
    this.pendingTask = null;  // Task if there is one running
  }
  Queue.prototype.run = function() {
    if (this.pendingTask) return; // Don't start multiple tasks at once
    var task = this.tasks.shift();
    if (!task) return;  // Nothing to do
    //sfig.L('START', task);
    sfig.L(task.name);
    var self = this;
    this.pendingTask = task;

    // Take the pending tasks and make sure that they go after any tasks added
    // by this next task.
    var saveTasks = this.tasks;
    this.tasks = [];
    task.func(function(error, stdout, stderr) {
      //sfig.L('RETURN', task, error);
      self.pendingTask = null;
      self.tasks = self.tasks.concat(saveTasks);
      if (error) {
        console.log(task.name + ': ' + error.toString());
        console.log(stdout);
      } else {
        self.run();
      }
    });
  }
  Queue.prototype.apply = function(cmd) {
    if (!sfig.isFunction(cmd)) throw 'Bad command (want function): ' + cmd;
    var func = function(callback) { cmd(); callback(); }
    this.tasks.push({name: '[javascript]', func: func});
    this.run();
  }
  Queue.prototype.system = function(cmd) {
    if (!sfig.isString(cmd)) throw 'Bad command (want string): ' + cmd;
    var self = this;
    var func = function(callback) { self.exec(cmd, callback); };
    this.tasks.push({name: cmd, func: func});
    this.run();
  }
  sfig_.queue = new Queue();

  // Options:
  //   outPrefix: directory to output.
  //   combine: whether to generate one PDF.
  //   lazy: don't re-generate if the PDF file already exists.
  sfig.Presentation.prototype.writePdf = function(opts) {
    var slideIndex = 0;

    var outPrefix = opts.outPrefix;
    if (outPrefix == null) throw 'Missing outPrefix (will output to the directory outPrefix)';

    // Combine if we're not writing to the current directory.
    var combine = opts.combine;
    if (combine == null) combine = outPrefix != '.';

    sfig_.queue.system('mkdir -p \'' + outPrefix + '\'');

    // Compute all image sizes
    var seenPaths = {};
    function computeImageSizes(block) {
      if (block instanceof sfig.Image) {
        var path = block.href().getOrDie();
        if (!seenPaths[path] && !Path.existsSync(path + '.info')) {
          seenPaths[path] = true;
          sfig_.queue.system(__dirname + '/../bin/compute-image-sizes.rb ' + path);
        }
      }
      block.children.forEach(computeImageSizes);
    }
    prez.slides.forEach(computeImageSizes);

    var paths = [];
    sfig_.queue.apply(function() {
      for (var slideIndex = 0; slideIndex < prez.slides.length; slideIndex++) {
        var slide = prez.slides[slideIndex];
        var id = slide.id().getOrElse(slideIndex);
        var slidePrefix = outPrefix + '/' + id;
        if (!opts.lazy || !Path.existsSync(slidePrefix + '.pdf')) {
          sfig.L('Slide ' + slideIndex + '/' + prez.slides.length + ': ' + id);
          createMetapost(slide, slidePrefix + '.mp');
        }
        paths.push(slidePrefix + '.pdf');
      }

      // Combine the PDFs of the individual slides into one master PDF.
      if (combine)
        sfig_.queue.system(__dirname + '/../bin/pdfjoin ' + paths.join(' ') + ' --outfile ' + outPrefix + '.pdf');
    });
  };
})();