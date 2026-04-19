#!/usr/bin/env node
import process from 'node:process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

//#region ../node_modules/.pnpm/js-yaml@4.1.1/node_modules/js-yaml/dist/js-yaml.mjs
/*! js-yaml 4.1.1 https://github.com/nodeca/js-yaml @license MIT */
function isNothing(subject) {
  return typeof subject === 'undefined' || subject === null;
}
function isObject(subject) {
  return typeof subject === 'object' && subject !== null;
}
function toArray(sequence) {
  if (Array.isArray(sequence)) return sequence;
  else if (isNothing(sequence)) return [];
  return [sequence];
}
function extend(target, source) {
  var index, length, key, sourceKeys;
  if (source) {
    sourceKeys = Object.keys(source);
    for (index = 0, length = sourceKeys.length; index < length; index += 1) {
      key = sourceKeys[index];
      target[key] = source[key];
    }
  }
  return target;
}
function repeat(string, count) {
  var result = '',
    cycle;
  for (cycle = 0; cycle < count; cycle += 1) result += string;
  return result;
}
function isNegativeZero(number) {
  return number === 0 && Number.NEGATIVE_INFINITY === 1 / number;
}
var common = {
  isNothing,
  isObject,
  toArray,
  repeat,
  isNegativeZero,
  extend,
};
function formatError(exception$1, compact) {
  var where = '',
    message = exception$1.reason || '(unknown reason)';
  if (!exception$1.mark) return message;
  if (exception$1.mark.name) where += 'in "' + exception$1.mark.name + '" ';
  where += '(' + (exception$1.mark.line + 1) + ':' + (exception$1.mark.column + 1) + ')';
  if (!compact && exception$1.mark.snippet) where += '\n\n' + exception$1.mark.snippet;
  return message + ' ' + where;
}
function YAMLException$1(reason, mark) {
  Error.call(this);
  this.name = 'YAMLException';
  this.reason = reason;
  this.mark = mark;
  this.message = formatError(this, false);
  if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  else this.stack = /* @__PURE__ */ new Error().stack || '';
}
YAMLException$1.prototype = Object.create(Error.prototype);
YAMLException$1.prototype.constructor = YAMLException$1;
YAMLException$1.prototype.toString = function toString(compact) {
  return this.name + ': ' + formatError(this, compact);
};
var exception = YAMLException$1;
function getLine(buffer, lineStart, lineEnd, position, maxLineLength) {
  var head = '';
  var tail = '';
  var maxHalfLength = Math.floor(maxLineLength / 2) - 1;
  if (position - lineStart > maxHalfLength) {
    head = ' ... ';
    lineStart = position - maxHalfLength + head.length;
  }
  if (lineEnd - position > maxHalfLength) {
    tail = ' ...';
    lineEnd = position + maxHalfLength - tail.length;
  }
  return {
    str: head + buffer.slice(lineStart, lineEnd).replace(/\t/g, '→') + tail,
    pos: position - lineStart + head.length,
  };
}
function padStart(string, max) {
  return common.repeat(' ', max - string.length) + string;
}
function makeSnippet(mark, options) {
  options = Object.create(options || null);
  if (!mark.buffer) return null;
  if (!options.maxLength) options.maxLength = 79;
  if (typeof options.indent !== 'number') options.indent = 1;
  if (typeof options.linesBefore !== 'number') options.linesBefore = 3;
  if (typeof options.linesAfter !== 'number') options.linesAfter = 2;
  var re = /\r?\n|\r|\0/g;
  var lineStarts = [0];
  var lineEnds = [];
  var match;
  var foundLineNo = -1;
  while ((match = re.exec(mark.buffer))) {
    lineEnds.push(match.index);
    lineStarts.push(match.index + match[0].length);
    if (mark.position <= match.index && foundLineNo < 0) foundLineNo = lineStarts.length - 2;
  }
  if (foundLineNo < 0) foundLineNo = lineStarts.length - 1;
  var result = '',
    i$1,
    line;
  var lineNoLength = Math.min(mark.line + options.linesAfter, lineEnds.length).toString().length;
  var maxLineLength = options.maxLength - (options.indent + lineNoLength + 3);
  for (i$1 = 1; i$1 <= options.linesBefore; i$1++) {
    if (foundLineNo - i$1 < 0) break;
    line = getLine(
      mark.buffer,
      lineStarts[foundLineNo - i$1],
      lineEnds[foundLineNo - i$1],
      mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo - i$1]),
      maxLineLength,
    );
    result =
      common.repeat(' ', options.indent) +
      padStart((mark.line - i$1 + 1).toString(), lineNoLength) +
      ' | ' +
      line.str +
      '\n' +
      result;
  }
  line = getLine(mark.buffer, lineStarts[foundLineNo], lineEnds[foundLineNo], mark.position, maxLineLength);
  result +=
    common.repeat(' ', options.indent) + padStart((mark.line + 1).toString(), lineNoLength) + ' | ' + line.str + '\n';
  result += common.repeat('-', options.indent + lineNoLength + 3 + line.pos) + '^\n';
  for (i$1 = 1; i$1 <= options.linesAfter; i$1++) {
    if (foundLineNo + i$1 >= lineEnds.length) break;
    line = getLine(
      mark.buffer,
      lineStarts[foundLineNo + i$1],
      lineEnds[foundLineNo + i$1],
      mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo + i$1]),
      maxLineLength,
    );
    result +=
      common.repeat(' ', options.indent) +
      padStart((mark.line + i$1 + 1).toString(), lineNoLength) +
      ' | ' +
      line.str +
      '\n';
  }
  return result.replace(/\n$/, '');
}
var snippet = makeSnippet;
var TYPE_CONSTRUCTOR_OPTIONS = [
  'kind',
  'multi',
  'resolve',
  'construct',
  'instanceOf',
  'predicate',
  'represent',
  'representName',
  'defaultStyle',
  'styleAliases',
];
var YAML_NODE_KINDS = ['scalar', 'sequence', 'mapping'];
function compileStyleAliases(map$1) {
  var result = {};
  if (map$1 !== null)
    Object.keys(map$1).forEach(function (style) {
      map$1[style].forEach(function (alias) {
        result[String(alias)] = style;
      });
    });
  return result;
}
function Type$1(tag, options) {
  options = options || {};
  Object.keys(options).forEach(function (name) {
    if (TYPE_CONSTRUCTOR_OPTIONS.indexOf(name) === -1)
      throw new exception('Unknown option "' + name + '" is met in definition of "' + tag + '" YAML type.');
  });
  this.options = options;
  this.tag = tag;
  this.kind = options['kind'] || null;
  this.resolve =
    options['resolve'] ||
    function () {
      return true;
    };
  this.construct =
    options['construct'] ||
    function (data) {
      return data;
    };
  this.instanceOf = options['instanceOf'] || null;
  this.predicate = options['predicate'] || null;
  this.represent = options['represent'] || null;
  this.representName = options['representName'] || null;
  this.defaultStyle = options['defaultStyle'] || null;
  this.multi = options['multi'] || false;
  this.styleAliases = compileStyleAliases(options['styleAliases'] || null);
  if (YAML_NODE_KINDS.indexOf(this.kind) === -1)
    throw new exception('Unknown kind "' + this.kind + '" is specified for "' + tag + '" YAML type.');
}
var type = Type$1;
function compileList(schema$1, name) {
  var result = [];
  schema$1[name].forEach(function (currentType) {
    var newIndex = result.length;
    result.forEach(function (previousType, previousIndex) {
      if (
        previousType.tag === currentType.tag &&
        previousType.kind === currentType.kind &&
        previousType.multi === currentType.multi
      )
        newIndex = previousIndex;
    });
    result[newIndex] = currentType;
  });
  return result;
}
function compileMap() {
  var result = {
      scalar: {},
      sequence: {},
      mapping: {},
      fallback: {},
      multi: {
        scalar: [],
        sequence: [],
        mapping: [],
        fallback: [],
      },
    },
    index,
    length;
  function collectType(type$1) {
    if (type$1.multi) {
      result.multi[type$1.kind].push(type$1);
      result.multi['fallback'].push(type$1);
    } else result[type$1.kind][type$1.tag] = result['fallback'][type$1.tag] = type$1;
  }
  for (index = 0, length = arguments.length; index < length; index += 1) arguments[index].forEach(collectType);
  return result;
}
function Schema$1(definition) {
  return this.extend(definition);
}
Schema$1.prototype.extend = function extend$1(definition) {
  var implicit = [];
  var explicit = [];
  if (definition instanceof type) explicit.push(definition);
  else if (Array.isArray(definition)) explicit = explicit.concat(definition);
  else if (definition && (Array.isArray(definition.implicit) || Array.isArray(definition.explicit))) {
    if (definition.implicit) implicit = implicit.concat(definition.implicit);
    if (definition.explicit) explicit = explicit.concat(definition.explicit);
  } else
    throw new exception(
      'Schema.extend argument should be a Type, [ Type ], or a schema definition ({ implicit: [...], explicit: [...] })',
    );
  implicit.forEach(function (type$1) {
    if (!(type$1 instanceof type))
      throw new exception('Specified list of YAML types (or a single Type object) contains a non-Type object.');
    if (type$1.loadKind && type$1.loadKind !== 'scalar')
      throw new exception(
        'There is a non-scalar type in the implicit list of a schema. Implicit resolving of such types is not supported.',
      );
    if (type$1.multi)
      throw new exception(
        'There is a multi type in the implicit list of a schema. Multi tags can only be listed as explicit.',
      );
  });
  explicit.forEach(function (type$1) {
    if (!(type$1 instanceof type))
      throw new exception('Specified list of YAML types (or a single Type object) contains a non-Type object.');
  });
  var result = Object.create(Schema$1.prototype);
  result.implicit = (this.implicit || []).concat(implicit);
  result.explicit = (this.explicit || []).concat(explicit);
  result.compiledImplicit = compileList(result, 'implicit');
  result.compiledExplicit = compileList(result, 'explicit');
  result.compiledTypeMap = compileMap(result.compiledImplicit, result.compiledExplicit);
  return result;
};
var schema = Schema$1;
var str = new type('tag:yaml.org,2002:str', {
  kind: 'scalar',
  construct: function (data) {
    return data !== null ? data : '';
  },
});
var seq = new type('tag:yaml.org,2002:seq', {
  kind: 'sequence',
  construct: function (data) {
    return data !== null ? data : [];
  },
});
var map = new type('tag:yaml.org,2002:map', {
  kind: 'mapping',
  construct: function (data) {
    return data !== null ? data : {};
  },
});
var failsafe = new schema({ explicit: [str, seq, map] });
function resolveYamlNull(data) {
  if (data === null) return true;
  var max = data.length;
  return (max === 1 && data === '~') || (max === 4 && (data === 'null' || data === 'Null' || data === 'NULL'));
}
function constructYamlNull() {
  return null;
}
function isNull(object) {
  return object === null;
}
var _null = new type('tag:yaml.org,2002:null', {
  kind: 'scalar',
  resolve: resolveYamlNull,
  construct: constructYamlNull,
  predicate: isNull,
  represent: {
    canonical: function () {
      return '~';
    },
    lowercase: function () {
      return 'null';
    },
    uppercase: function () {
      return 'NULL';
    },
    camelcase: function () {
      return 'Null';
    },
    empty: function () {
      return '';
    },
  },
  defaultStyle: 'lowercase',
});
function resolveYamlBoolean(data) {
  if (data === null) return false;
  var max = data.length;
  return (
    (max === 4 && (data === 'true' || data === 'True' || data === 'TRUE')) ||
    (max === 5 && (data === 'false' || data === 'False' || data === 'FALSE'))
  );
}
function constructYamlBoolean(data) {
  return data === 'true' || data === 'True' || data === 'TRUE';
}
function isBoolean(object) {
  return Object.prototype.toString.call(object) === '[object Boolean]';
}
var bool = new type('tag:yaml.org,2002:bool', {
  kind: 'scalar',
  resolve: resolveYamlBoolean,
  construct: constructYamlBoolean,
  predicate: isBoolean,
  represent: {
    lowercase: function (object) {
      return object ? 'true' : 'false';
    },
    uppercase: function (object) {
      return object ? 'TRUE' : 'FALSE';
    },
    camelcase: function (object) {
      return object ? 'True' : 'False';
    },
  },
  defaultStyle: 'lowercase',
});
function isHexCode(c) {
  return (48 <= c && c <= 57) || (65 <= c && c <= 70) || (97 <= c && c <= 102);
}
function isOctCode(c) {
  return 48 <= c && c <= 55;
}
function isDecCode(c) {
  return 48 <= c && c <= 57;
}
function resolveYamlInteger(data) {
  if (data === null) return false;
  var max = data.length,
    index = 0,
    hasDigits = false,
    ch;
  if (!max) return false;
  ch = data[index];
  if (ch === '-' || ch === '+') ch = data[++index];
  if (ch === '0') {
    if (index + 1 === max) return true;
    ch = data[++index];
    if (ch === 'b') {
      index++;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === '_') continue;
        if (ch !== '0' && ch !== '1') return false;
        hasDigits = true;
      }
      return hasDigits && ch !== '_';
    }
    if (ch === 'x') {
      index++;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === '_') continue;
        if (!isHexCode(data.charCodeAt(index))) return false;
        hasDigits = true;
      }
      return hasDigits && ch !== '_';
    }
    if (ch === 'o') {
      index++;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === '_') continue;
        if (!isOctCode(data.charCodeAt(index))) return false;
        hasDigits = true;
      }
      return hasDigits && ch !== '_';
    }
  }
  if (ch === '_') return false;
  for (; index < max; index++) {
    ch = data[index];
    if (ch === '_') continue;
    if (!isDecCode(data.charCodeAt(index))) return false;
    hasDigits = true;
  }
  if (!hasDigits || ch === '_') return false;
  return true;
}
function constructYamlInteger(data) {
  var value = data,
    sign = 1,
    ch;
  if (value.indexOf('_') !== -1) value = value.replace(/_/g, '');
  ch = value[0];
  if (ch === '-' || ch === '+') {
    if (ch === '-') sign = -1;
    value = value.slice(1);
    ch = value[0];
  }
  if (value === '0') return 0;
  if (ch === '0') {
    if (value[1] === 'b') return sign * parseInt(value.slice(2), 2);
    if (value[1] === 'x') return sign * parseInt(value.slice(2), 16);
    if (value[1] === 'o') return sign * parseInt(value.slice(2), 8);
  }
  return sign * parseInt(value, 10);
}
function isInteger(object) {
  return (
    Object.prototype.toString.call(object) === '[object Number]' && object % 1 === 0 && !common.isNegativeZero(object)
  );
}
var int = new type('tag:yaml.org,2002:int', {
  kind: 'scalar',
  resolve: resolveYamlInteger,
  construct: constructYamlInteger,
  predicate: isInteger,
  represent: {
    binary: function (obj) {
      return obj >= 0 ? '0b' + obj.toString(2) : '-0b' + obj.toString(2).slice(1);
    },
    octal: function (obj) {
      return obj >= 0 ? '0o' + obj.toString(8) : '-0o' + obj.toString(8).slice(1);
    },
    decimal: function (obj) {
      return obj.toString(10);
    },
    hexadecimal: function (obj) {
      return obj >= 0 ? '0x' + obj.toString(16).toUpperCase() : '-0x' + obj.toString(16).toUpperCase().slice(1);
    },
  },
  defaultStyle: 'decimal',
  styleAliases: {
    binary: [2, 'bin'],
    octal: [8, 'oct'],
    decimal: [10, 'dec'],
    hexadecimal: [16, 'hex'],
  },
});
var YAML_FLOAT_PATTERN = /* @__PURE__ */ new RegExp(
  '^(?:[-+]?(?:[0-9][0-9_]*)(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$',
);
function resolveYamlFloat(data) {
  if (data === null) return false;
  if (!YAML_FLOAT_PATTERN.test(data) || data[data.length - 1] === '_') return false;
  return true;
}
function constructYamlFloat(data) {
  var value = data.replace(/_/g, '').toLowerCase(),
    sign = value[0] === '-' ? -1 : 1;
  if ('+-'.indexOf(value[0]) >= 0) value = value.slice(1);
  if (value === '.inf') return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  else if (value === '.nan') return NaN;
  return sign * parseFloat(value, 10);
}
var SCIENTIFIC_WITHOUT_DOT = /^[-+]?[0-9]+e/;
function representYamlFloat(object, style) {
  var res;
  if (isNaN(object))
    switch (style) {
      case 'lowercase':
        return '.nan';
      case 'uppercase':
        return '.NAN';
      case 'camelcase':
        return '.NaN';
    }
  else if (Number.POSITIVE_INFINITY === object)
    switch (style) {
      case 'lowercase':
        return '.inf';
      case 'uppercase':
        return '.INF';
      case 'camelcase':
        return '.Inf';
    }
  else if (Number.NEGATIVE_INFINITY === object)
    switch (style) {
      case 'lowercase':
        return '-.inf';
      case 'uppercase':
        return '-.INF';
      case 'camelcase':
        return '-.Inf';
    }
  else if (common.isNegativeZero(object)) return '-0.0';
  res = object.toString(10);
  return SCIENTIFIC_WITHOUT_DOT.test(res) ? res.replace('e', '.e') : res;
}
function isFloat(object) {
  return (
    Object.prototype.toString.call(object) === '[object Number]' && (object % 1 !== 0 || common.isNegativeZero(object))
  );
}
var float = new type('tag:yaml.org,2002:float', {
  kind: 'scalar',
  resolve: resolveYamlFloat,
  construct: constructYamlFloat,
  predicate: isFloat,
  represent: representYamlFloat,
  defaultStyle: 'lowercase',
});
var json = failsafe.extend({ implicit: [_null, bool, int, float] });
var core = json;
var YAML_DATE_REGEXP = /* @__PURE__ */ new RegExp('^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$');
var YAML_TIMESTAMP_REGEXP = /* @__PURE__ */ new RegExp(
  '^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$',
);
function resolveYamlTimestamp(data) {
  if (data === null) return false;
  if (YAML_DATE_REGEXP.exec(data) !== null) return true;
  if (YAML_TIMESTAMP_REGEXP.exec(data) !== null) return true;
  return false;
}
function constructYamlTimestamp(data) {
  var match,
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction = 0,
    delta = null,
    tz_hour,
    tz_minute,
    date;
  match = YAML_DATE_REGEXP.exec(data);
  if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(data);
  if (match === null) throw new Error('Date resolve error');
  year = +match[1];
  month = +match[2] - 1;
  day = +match[3];
  if (!match[4]) return new Date(Date.UTC(year, month, day));
  hour = +match[4];
  minute = +match[5];
  second = +match[6];
  if (match[7]) {
    fraction = match[7].slice(0, 3);
    while (fraction.length < 3) fraction += '0';
    fraction = +fraction;
  }
  if (match[9]) {
    tz_hour = +match[10];
    tz_minute = +(match[11] || 0);
    delta = (tz_hour * 60 + tz_minute) * 6e4;
    if (match[9] === '-') delta = -delta;
  }
  date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
  if (delta) date.setTime(date.getTime() - delta);
  return date;
}
function representYamlTimestamp(object) {
  return object.toISOString();
}
var timestamp = new type('tag:yaml.org,2002:timestamp', {
  kind: 'scalar',
  resolve: resolveYamlTimestamp,
  construct: constructYamlTimestamp,
  instanceOf: Date,
  represent: representYamlTimestamp,
});
function resolveYamlMerge(data) {
  return data === '<<' || data === null;
}
var merge = new type('tag:yaml.org,2002:merge', {
  kind: 'scalar',
  resolve: resolveYamlMerge,
});
var BASE64_MAP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n\r';
function resolveYamlBinary(data) {
  if (data === null) return false;
  var code,
    idx,
    bitlen = 0,
    max = data.length,
    map$1 = BASE64_MAP;
  for (idx = 0; idx < max; idx++) {
    code = map$1.indexOf(data.charAt(idx));
    if (code > 64) continue;
    if (code < 0) return false;
    bitlen += 6;
  }
  return bitlen % 8 === 0;
}
function constructYamlBinary(data) {
  var idx,
    tailbits,
    input = data.replace(/[\r\n=]/g, ''),
    max = input.length,
    map$1 = BASE64_MAP,
    bits = 0,
    result = [];
  for (idx = 0; idx < max; idx++) {
    if (idx % 4 === 0 && idx) {
      result.push((bits >> 16) & 255);
      result.push((bits >> 8) & 255);
      result.push(bits & 255);
    }
    bits = (bits << 6) | map$1.indexOf(input.charAt(idx));
  }
  tailbits = (max % 4) * 6;
  if (tailbits === 0) {
    result.push((bits >> 16) & 255);
    result.push((bits >> 8) & 255);
    result.push(bits & 255);
  } else if (tailbits === 18) {
    result.push((bits >> 10) & 255);
    result.push((bits >> 2) & 255);
  } else if (tailbits === 12) result.push((bits >> 4) & 255);
  return new Uint8Array(result);
}
function representYamlBinary(object) {
  var result = '',
    bits = 0,
    idx,
    tail,
    max = object.length,
    map$1 = BASE64_MAP;
  for (idx = 0; idx < max; idx++) {
    if (idx % 3 === 0 && idx) {
      result += map$1[(bits >> 18) & 63];
      result += map$1[(bits >> 12) & 63];
      result += map$1[(bits >> 6) & 63];
      result += map$1[bits & 63];
    }
    bits = (bits << 8) + object[idx];
  }
  tail = max % 3;
  if (tail === 0) {
    result += map$1[(bits >> 18) & 63];
    result += map$1[(bits >> 12) & 63];
    result += map$1[(bits >> 6) & 63];
    result += map$1[bits & 63];
  } else if (tail === 2) {
    result += map$1[(bits >> 10) & 63];
    result += map$1[(bits >> 4) & 63];
    result += map$1[(bits << 2) & 63];
    result += map$1[64];
  } else if (tail === 1) {
    result += map$1[(bits >> 2) & 63];
    result += map$1[(bits << 4) & 63];
    result += map$1[64];
    result += map$1[64];
  }
  return result;
}
function isBinary(obj) {
  return Object.prototype.toString.call(obj) === '[object Uint8Array]';
}
var binary = new type('tag:yaml.org,2002:binary', {
  kind: 'scalar',
  resolve: resolveYamlBinary,
  construct: constructYamlBinary,
  predicate: isBinary,
  represent: representYamlBinary,
});
var _hasOwnProperty$3 = Object.prototype.hasOwnProperty;
var _toString$2 = Object.prototype.toString;
function resolveYamlOmap(data) {
  if (data === null) return true;
  var objectKeys = [],
    index,
    length,
    pair,
    pairKey,
    pairHasKey,
    object = data;
  for (index = 0, length = object.length; index < length; index += 1) {
    pair = object[index];
    pairHasKey = false;
    if (_toString$2.call(pair) !== '[object Object]') return false;
    for (pairKey in pair)
      if (_hasOwnProperty$3.call(pair, pairKey))
        if (!pairHasKey) pairHasKey = true;
        else return false;
    if (!pairHasKey) return false;
    if (objectKeys.indexOf(pairKey) === -1) objectKeys.push(pairKey);
    else return false;
  }
  return true;
}
function constructYamlOmap(data) {
  return data !== null ? data : [];
}
var omap = new type('tag:yaml.org,2002:omap', {
  kind: 'sequence',
  resolve: resolveYamlOmap,
  construct: constructYamlOmap,
});
var _toString$1 = Object.prototype.toString;
function resolveYamlPairs(data) {
  if (data === null) return true;
  var index,
    length,
    pair,
    keys,
    result,
    object = data;
  result = new Array(object.length);
  for (index = 0, length = object.length; index < length; index += 1) {
    pair = object[index];
    if (_toString$1.call(pair) !== '[object Object]') return false;
    keys = Object.keys(pair);
    if (keys.length !== 1) return false;
    result[index] = [keys[0], pair[keys[0]]];
  }
  return true;
}
function constructYamlPairs(data) {
  if (data === null) return [];
  var index,
    length,
    pair,
    keys,
    result,
    object = data;
  result = new Array(object.length);
  for (index = 0, length = object.length; index < length; index += 1) {
    pair = object[index];
    keys = Object.keys(pair);
    result[index] = [keys[0], pair[keys[0]]];
  }
  return result;
}
var pairs = new type('tag:yaml.org,2002:pairs', {
  kind: 'sequence',
  resolve: resolveYamlPairs,
  construct: constructYamlPairs,
});
var _hasOwnProperty$2 = Object.prototype.hasOwnProperty;
function resolveYamlSet(data) {
  if (data === null) return true;
  var key,
    object = data;
  for (key in object)
    if (_hasOwnProperty$2.call(object, key)) {
      if (object[key] !== null) return false;
    }
  return true;
}
function constructYamlSet(data) {
  return data !== null ? data : {};
}
var set = new type('tag:yaml.org,2002:set', {
  kind: 'mapping',
  resolve: resolveYamlSet,
  construct: constructYamlSet,
});
var _default = core.extend({
  implicit: [timestamp, merge],
  explicit: [binary, omap, pairs, set],
});
var _hasOwnProperty$1 = Object.prototype.hasOwnProperty;
var CONTEXT_FLOW_IN = 1;
var CONTEXT_FLOW_OUT = 2;
var CONTEXT_BLOCK_IN = 3;
var CONTEXT_BLOCK_OUT = 4;
var CHOMPING_CLIP = 1;
var CHOMPING_STRIP = 2;
var CHOMPING_KEEP = 3;
var PATTERN_NON_PRINTABLE =
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
var PATTERN_NON_ASCII_LINE_BREAKS = /[\x85\u2028\u2029]/;
var PATTERN_FLOW_INDICATORS = /[,\[\]\{\}]/;
var PATTERN_TAG_HANDLE = /^(?:!|!!|![a-z\-]+!)$/i;
var PATTERN_TAG_URI = /^(?:!|[^,\[\]\{\}])(?:%[0-9a-f]{2}|[0-9a-z\-#;\/\?:@&=\+\$,_\.!~\*'\(\)\[\]])*$/i;
function _class(obj) {
  return Object.prototype.toString.call(obj);
}
function is_EOL(c) {
  return c === 10 || c === 13;
}
function is_WHITE_SPACE(c) {
  return c === 9 || c === 32;
}
function is_WS_OR_EOL(c) {
  return c === 9 || c === 32 || c === 10 || c === 13;
}
function is_FLOW_INDICATOR(c) {
  return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
}
function fromHexCode(c) {
  var lc;
  if (48 <= c && c <= 57) return c - 48;
  lc = c | 32;
  if (97 <= lc && lc <= 102) return lc - 97 + 10;
  return -1;
}
function escapedHexLen(c) {
  if (c === 120) return 2;
  if (c === 117) return 4;
  if (c === 85) return 8;
  return 0;
}
function fromDecimalCode(c) {
  if (48 <= c && c <= 57) return c - 48;
  return -1;
}
function simpleEscapeSequence(c) {
  return c === 48
    ? '\0'
    : c === 97
      ? '\x07'
      : c === 98
        ? '\b'
        : c === 116
          ? '	'
          : c === 9
            ? '	'
            : c === 110
              ? '\n'
              : c === 118
                ? '\v'
                : c === 102
                  ? '\f'
                  : c === 114
                    ? '\r'
                    : c === 101
                      ? '\x1B'
                      : c === 32
                        ? ' '
                        : c === 34
                          ? '"'
                          : c === 47
                            ? '/'
                            : c === 92
                              ? '\\'
                              : c === 78
                                ? ''
                                : c === 95
                                  ? '\xA0'
                                  : c === 76
                                    ? '\u2028'
                                    : c === 80
                                      ? '\u2029'
                                      : '';
}
function charFromCodepoint(c) {
  if (c <= 65535) return String.fromCharCode(c);
  return String.fromCharCode(((c - 65536) >> 10) + 55296, ((c - 65536) & 1023) + 56320);
}
function setProperty(object, key, value) {
  if (key === '__proto__')
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  else object[key] = value;
}
var simpleEscapeCheck = new Array(256);
var simpleEscapeMap = new Array(256);
for (var i = 0; i < 256; i++) {
  simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
  simpleEscapeMap[i] = simpleEscapeSequence(i);
}
function State$1(input, options) {
  this.input = input;
  this.filename = options['filename'] || null;
  this.schema = options['schema'] || _default;
  this.onWarning = options['onWarning'] || null;
  this.legacy = options['legacy'] || false;
  this.json = options['json'] || false;
  this.listener = options['listener'] || null;
  this.implicitTypes = this.schema.compiledImplicit;
  this.typeMap = this.schema.compiledTypeMap;
  this.length = input.length;
  this.position = 0;
  this.line = 0;
  this.lineStart = 0;
  this.lineIndent = 0;
  this.firstTabInLine = -1;
  this.documents = [];
}
function generateError(state, message) {
  var mark = {
    name: state.filename,
    buffer: state.input.slice(0, -1),
    position: state.position,
    line: state.line,
    column: state.position - state.lineStart,
  };
  mark.snippet = snippet(mark);
  return new exception(message, mark);
}
function throwError(state, message) {
  throw generateError(state, message);
}
function throwWarning(state, message) {
  if (state.onWarning) state.onWarning.call(null, generateError(state, message));
}
var directiveHandlers = {
  YAML: function handleYamlDirective(state, name, args) {
    var match, major, minor;
    if (state.version !== null) throwError(state, 'duplication of %YAML directive');
    if (args.length !== 1) throwError(state, 'YAML directive accepts exactly one argument');
    match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
    if (match === null) throwError(state, 'ill-formed argument of the YAML directive');
    major = parseInt(match[1], 10);
    minor = parseInt(match[2], 10);
    if (major !== 1) throwError(state, 'unacceptable YAML version of the document');
    state.version = args[0];
    state.checkLineBreaks = minor < 2;
    if (minor !== 1 && minor !== 2) throwWarning(state, 'unsupported YAML version of the document');
  },
  TAG: function handleTagDirective(state, name, args) {
    var handle, prefix;
    if (args.length !== 2) throwError(state, 'TAG directive accepts exactly two arguments');
    handle = args[0];
    prefix = args[1];
    if (!PATTERN_TAG_HANDLE.test(handle))
      throwError(state, 'ill-formed tag handle (first argument) of the TAG directive');
    if (_hasOwnProperty$1.call(state.tagMap, handle))
      throwError(state, 'there is a previously declared suffix for "' + handle + '" tag handle');
    if (!PATTERN_TAG_URI.test(prefix))
      throwError(state, 'ill-formed tag prefix (second argument) of the TAG directive');
    try {
      prefix = decodeURIComponent(prefix);
    } catch (err) {
      throwError(state, 'tag prefix is malformed: ' + prefix);
    }
    state.tagMap[handle] = prefix;
  },
};
function captureSegment(state, start, end, checkJson) {
  var _position, _length, _character, _result;
  if (start < end) {
    _result = state.input.slice(start, end);
    if (checkJson)
      for (_position = 0, _length = _result.length; _position < _length; _position += 1) {
        _character = _result.charCodeAt(_position);
        if (!(_character === 9 || (32 <= _character && _character <= 1114111)))
          throwError(state, 'expected valid JSON character');
      }
    else if (PATTERN_NON_PRINTABLE.test(_result)) throwError(state, 'the stream contains non-printable characters');
    state.result += _result;
  }
}
function mergeMappings(state, destination, source, overridableKeys) {
  var sourceKeys, key, index, quantity;
  if (!common.isObject(source)) throwError(state, 'cannot merge mappings; the provided source object is unacceptable');
  sourceKeys = Object.keys(source);
  for (index = 0, quantity = sourceKeys.length; index < quantity; index += 1) {
    key = sourceKeys[index];
    if (!_hasOwnProperty$1.call(destination, key)) {
      setProperty(destination, key, source[key]);
      overridableKeys[key] = true;
    }
  }
}
function storeMappingPair(
  state,
  _result,
  overridableKeys,
  keyTag,
  keyNode,
  valueNode,
  startLine,
  startLineStart,
  startPos,
) {
  var index, quantity;
  if (Array.isArray(keyNode)) {
    keyNode = Array.prototype.slice.call(keyNode);
    for (index = 0, quantity = keyNode.length; index < quantity; index += 1) {
      if (Array.isArray(keyNode[index])) throwError(state, 'nested arrays are not supported inside keys');
      if (typeof keyNode === 'object' && _class(keyNode[index]) === '[object Object]')
        keyNode[index] = '[object Object]';
    }
  }
  if (typeof keyNode === 'object' && _class(keyNode) === '[object Object]') keyNode = '[object Object]';
  keyNode = String(keyNode);
  if (_result === null) _result = {};
  if (keyTag === 'tag:yaml.org,2002:merge')
    if (Array.isArray(valueNode))
      for (index = 0, quantity = valueNode.length; index < quantity; index += 1)
        mergeMappings(state, _result, valueNode[index], overridableKeys);
    else mergeMappings(state, _result, valueNode, overridableKeys);
  else {
    if (!state.json && !_hasOwnProperty$1.call(overridableKeys, keyNode) && _hasOwnProperty$1.call(_result, keyNode)) {
      state.line = startLine || state.line;
      state.lineStart = startLineStart || state.lineStart;
      state.position = startPos || state.position;
      throwError(state, 'duplicated mapping key');
    }
    setProperty(_result, keyNode, valueNode);
    delete overridableKeys[keyNode];
  }
  return _result;
}
function readLineBreak(state) {
  var ch = state.input.charCodeAt(state.position);
  if (ch === 10) state.position++;
  else if (ch === 13) {
    state.position++;
    if (state.input.charCodeAt(state.position) === 10) state.position++;
  } else throwError(state, 'a line break is expected');
  state.line += 1;
  state.lineStart = state.position;
  state.firstTabInLine = -1;
}
function skipSeparationSpace(state, allowComments, checkIndent) {
  var lineBreaks = 0,
    ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    while (is_WHITE_SPACE(ch)) {
      if (ch === 9 && state.firstTabInLine === -1) state.firstTabInLine = state.position;
      ch = state.input.charCodeAt(++state.position);
    }
    if (allowComments && ch === 35)
      do ch = state.input.charCodeAt(++state.position);
      while (ch !== 10 && ch !== 13 && ch !== 0);
    if (is_EOL(ch)) {
      readLineBreak(state);
      ch = state.input.charCodeAt(state.position);
      lineBreaks++;
      state.lineIndent = 0;
      while (ch === 32) {
        state.lineIndent++;
        ch = state.input.charCodeAt(++state.position);
      }
    } else break;
  }
  if (checkIndent !== -1 && lineBreaks !== 0 && state.lineIndent < checkIndent)
    throwWarning(state, 'deficient indentation');
  return lineBreaks;
}
function testDocumentSeparator(state) {
  var _position = state.position,
    ch = state.input.charCodeAt(_position);
  if (
    (ch === 45 || ch === 46) &&
    ch === state.input.charCodeAt(_position + 1) &&
    ch === state.input.charCodeAt(_position + 2)
  ) {
    _position += 3;
    ch = state.input.charCodeAt(_position);
    if (ch === 0 || is_WS_OR_EOL(ch)) return true;
  }
  return false;
}
function writeFoldedLines(state, count) {
  if (count === 1) state.result += ' ';
  else if (count > 1) state.result += common.repeat('\n', count - 1);
}
function readPlainScalar(state, nodeIndent, withinFlowCollection) {
  var preceding,
    following,
    captureStart,
    captureEnd,
    hasPendingContent,
    _line,
    _lineStart,
    _lineIndent,
    _kind = state.kind,
    _result = state.result,
    ch = state.input.charCodeAt(state.position);
  if (
    is_WS_OR_EOL(ch) ||
    is_FLOW_INDICATOR(ch) ||
    ch === 35 ||
    ch === 38 ||
    ch === 42 ||
    ch === 33 ||
    ch === 124 ||
    ch === 62 ||
    ch === 39 ||
    ch === 34 ||
    ch === 37 ||
    ch === 64 ||
    ch === 96
  )
    return false;
  if (ch === 63 || ch === 45) {
    following = state.input.charCodeAt(state.position + 1);
    if (is_WS_OR_EOL(following) || (withinFlowCollection && is_FLOW_INDICATOR(following))) return false;
  }
  state.kind = 'scalar';
  state.result = '';
  captureStart = captureEnd = state.position;
  hasPendingContent = false;
  while (ch !== 0) {
    if (ch === 58) {
      following = state.input.charCodeAt(state.position + 1);
      if (is_WS_OR_EOL(following) || (withinFlowCollection && is_FLOW_INDICATOR(following))) break;
    } else if (ch === 35) {
      preceding = state.input.charCodeAt(state.position - 1);
      if (is_WS_OR_EOL(preceding)) break;
    } else if (
      (state.position === state.lineStart && testDocumentSeparator(state)) ||
      (withinFlowCollection && is_FLOW_INDICATOR(ch))
    )
      break;
    else if (is_EOL(ch)) {
      _line = state.line;
      _lineStart = state.lineStart;
      _lineIndent = state.lineIndent;
      skipSeparationSpace(state, false, -1);
      if (state.lineIndent >= nodeIndent) {
        hasPendingContent = true;
        ch = state.input.charCodeAt(state.position);
        continue;
      } else {
        state.position = captureEnd;
        state.line = _line;
        state.lineStart = _lineStart;
        state.lineIndent = _lineIndent;
        break;
      }
    }
    if (hasPendingContent) {
      captureSegment(state, captureStart, captureEnd, false);
      writeFoldedLines(state, state.line - _line);
      captureStart = captureEnd = state.position;
      hasPendingContent = false;
    }
    if (!is_WHITE_SPACE(ch)) captureEnd = state.position + 1;
    ch = state.input.charCodeAt(++state.position);
  }
  captureSegment(state, captureStart, captureEnd, false);
  if (state.result) return true;
  state.kind = _kind;
  state.result = _result;
  return false;
}
function readSingleQuotedScalar(state, nodeIndent) {
  var ch = state.input.charCodeAt(state.position),
    captureStart,
    captureEnd;
  if (ch !== 39) return false;
  state.kind = 'scalar';
  state.result = '';
  state.position++;
  captureStart = captureEnd = state.position;
  while ((ch = state.input.charCodeAt(state.position)) !== 0)
    if (ch === 39) {
      captureSegment(state, captureStart, state.position, true);
      ch = state.input.charCodeAt(++state.position);
      if (ch === 39) {
        captureStart = state.position;
        state.position++;
        captureEnd = state.position;
      } else return true;
    } else if (is_EOL(ch)) {
      captureSegment(state, captureStart, captureEnd, true);
      writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
      captureStart = captureEnd = state.position;
    } else if (state.position === state.lineStart && testDocumentSeparator(state))
      throwError(state, 'unexpected end of the document within a single quoted scalar');
    else {
      state.position++;
      captureEnd = state.position;
    }
  throwError(state, 'unexpected end of the stream within a single quoted scalar');
}
function readDoubleQuotedScalar(state, nodeIndent) {
  var captureStart,
    captureEnd,
    hexLength,
    hexResult,
    tmp,
    ch = state.input.charCodeAt(state.position);
  if (ch !== 34) return false;
  state.kind = 'scalar';
  state.result = '';
  state.position++;
  captureStart = captureEnd = state.position;
  while ((ch = state.input.charCodeAt(state.position)) !== 0)
    if (ch === 34) {
      captureSegment(state, captureStart, state.position, true);
      state.position++;
      return true;
    } else if (ch === 92) {
      captureSegment(state, captureStart, state.position, true);
      ch = state.input.charCodeAt(++state.position);
      if (is_EOL(ch)) skipSeparationSpace(state, false, nodeIndent);
      else if (ch < 256 && simpleEscapeCheck[ch]) {
        state.result += simpleEscapeMap[ch];
        state.position++;
      } else if ((tmp = escapedHexLen(ch)) > 0) {
        hexLength = tmp;
        hexResult = 0;
        for (; hexLength > 0; hexLength--) {
          ch = state.input.charCodeAt(++state.position);
          if ((tmp = fromHexCode(ch)) >= 0) hexResult = (hexResult << 4) + tmp;
          else throwError(state, 'expected hexadecimal character');
        }
        state.result += charFromCodepoint(hexResult);
        state.position++;
      } else throwError(state, 'unknown escape sequence');
      captureStart = captureEnd = state.position;
    } else if (is_EOL(ch)) {
      captureSegment(state, captureStart, captureEnd, true);
      writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
      captureStart = captureEnd = state.position;
    } else if (state.position === state.lineStart && testDocumentSeparator(state))
      throwError(state, 'unexpected end of the document within a double quoted scalar');
    else {
      state.position++;
      captureEnd = state.position;
    }
  throwError(state, 'unexpected end of the stream within a double quoted scalar');
}
function readFlowCollection(state, nodeIndent) {
  var readNext = true,
    _line,
    _lineStart,
    _pos,
    _tag = state.tag,
    _result,
    _anchor = state.anchor,
    following,
    terminator,
    isPair,
    isExplicitPair,
    isMapping,
    overridableKeys = Object.create(null),
    keyNode,
    keyTag,
    valueNode,
    ch = state.input.charCodeAt(state.position);
  if (ch === 91) {
    terminator = 93;
    isMapping = false;
    _result = [];
  } else if (ch === 123) {
    terminator = 125;
    isMapping = true;
    _result = {};
  } else return false;
  if (state.anchor !== null) state.anchorMap[state.anchor] = _result;
  ch = state.input.charCodeAt(++state.position);
  while (ch !== 0) {
    skipSeparationSpace(state, true, nodeIndent);
    ch = state.input.charCodeAt(state.position);
    if (ch === terminator) {
      state.position++;
      state.tag = _tag;
      state.anchor = _anchor;
      state.kind = isMapping ? 'mapping' : 'sequence';
      state.result = _result;
      return true;
    } else if (!readNext) throwError(state, 'missed comma between flow collection entries');
    else if (ch === 44) throwError(state, "expected the node content, but found ','");
    keyTag = keyNode = valueNode = null;
    isPair = isExplicitPair = false;
    if (ch === 63) {
      following = state.input.charCodeAt(state.position + 1);
      if (is_WS_OR_EOL(following)) {
        isPair = isExplicitPair = true;
        state.position++;
        skipSeparationSpace(state, true, nodeIndent);
      }
    }
    _line = state.line;
    _lineStart = state.lineStart;
    _pos = state.position;
    composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
    keyTag = state.tag;
    keyNode = state.result;
    skipSeparationSpace(state, true, nodeIndent);
    ch = state.input.charCodeAt(state.position);
    if ((isExplicitPair || state.line === _line) && ch === 58) {
      isPair = true;
      ch = state.input.charCodeAt(++state.position);
      skipSeparationSpace(state, true, nodeIndent);
      composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
      valueNode = state.result;
    }
    if (isMapping)
      storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos);
    else if (isPair)
      _result.push(storeMappingPair(state, null, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos));
    else _result.push(keyNode);
    skipSeparationSpace(state, true, nodeIndent);
    ch = state.input.charCodeAt(state.position);
    if (ch === 44) {
      readNext = true;
      ch = state.input.charCodeAt(++state.position);
    } else readNext = false;
  }
  throwError(state, 'unexpected end of the stream within a flow collection');
}
function readBlockScalar(state, nodeIndent) {
  var captureStart,
    folding,
    chomping = CHOMPING_CLIP,
    didReadContent = false,
    detectedIndent = false,
    textIndent = nodeIndent,
    emptyLines = 0,
    atMoreIndented = false,
    tmp,
    ch = state.input.charCodeAt(state.position);
  if (ch === 124) folding = false;
  else if (ch === 62) folding = true;
  else return false;
  state.kind = 'scalar';
  state.result = '';
  while (ch !== 0) {
    ch = state.input.charCodeAt(++state.position);
    if (ch === 43 || ch === 45)
      if (CHOMPING_CLIP === chomping) chomping = ch === 43 ? CHOMPING_KEEP : CHOMPING_STRIP;
      else throwError(state, 'repeat of a chomping mode identifier');
    else if ((tmp = fromDecimalCode(ch)) >= 0)
      if (tmp === 0) throwError(state, 'bad explicit indentation width of a block scalar; it cannot be less than one');
      else if (!detectedIndent) {
        textIndent = nodeIndent + tmp - 1;
        detectedIndent = true;
      } else throwError(state, 'repeat of an indentation width identifier');
    else break;
  }
  if (is_WHITE_SPACE(ch)) {
    do ch = state.input.charCodeAt(++state.position);
    while (is_WHITE_SPACE(ch));
    if (ch === 35)
      do ch = state.input.charCodeAt(++state.position);
      while (!is_EOL(ch) && ch !== 0);
  }
  while (ch !== 0) {
    readLineBreak(state);
    state.lineIndent = 0;
    ch = state.input.charCodeAt(state.position);
    while ((!detectedIndent || state.lineIndent < textIndent) && ch === 32) {
      state.lineIndent++;
      ch = state.input.charCodeAt(++state.position);
    }
    if (!detectedIndent && state.lineIndent > textIndent) textIndent = state.lineIndent;
    if (is_EOL(ch)) {
      emptyLines++;
      continue;
    }
    if (state.lineIndent < textIndent) {
      if (chomping === CHOMPING_KEEP) state.result += common.repeat('\n', didReadContent ? 1 + emptyLines : emptyLines);
      else if (chomping === CHOMPING_CLIP) {
        if (didReadContent) state.result += '\n';
      }
      break;
    }
    if (folding)
      if (is_WHITE_SPACE(ch)) {
        atMoreIndented = true;
        state.result += common.repeat('\n', didReadContent ? 1 + emptyLines : emptyLines);
      } else if (atMoreIndented) {
        atMoreIndented = false;
        state.result += common.repeat('\n', emptyLines + 1);
      } else if (emptyLines === 0) {
        if (didReadContent) state.result += ' ';
      } else state.result += common.repeat('\n', emptyLines);
    else state.result += common.repeat('\n', didReadContent ? 1 + emptyLines : emptyLines);
    didReadContent = true;
    detectedIndent = true;
    emptyLines = 0;
    captureStart = state.position;
    while (!is_EOL(ch) && ch !== 0) ch = state.input.charCodeAt(++state.position);
    captureSegment(state, captureStart, state.position, false);
  }
  return true;
}
function readBlockSequence(state, nodeIndent) {
  var _line,
    _tag = state.tag,
    _anchor = state.anchor,
    _result = [],
    following,
    detected = false,
    ch;
  if (state.firstTabInLine !== -1) return false;
  if (state.anchor !== null) state.anchorMap[state.anchor] = _result;
  ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    if (state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, 'tab characters must not be used in indentation');
    }
    if (ch !== 45) break;
    following = state.input.charCodeAt(state.position + 1);
    if (!is_WS_OR_EOL(following)) break;
    detected = true;
    state.position++;
    if (skipSeparationSpace(state, true, -1)) {
      if (state.lineIndent <= nodeIndent) {
        _result.push(null);
        ch = state.input.charCodeAt(state.position);
        continue;
      }
    }
    _line = state.line;
    composeNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
    _result.push(state.result);
    skipSeparationSpace(state, true, -1);
    ch = state.input.charCodeAt(state.position);
    if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0)
      throwError(state, 'bad indentation of a sequence entry');
    else if (state.lineIndent < nodeIndent) break;
  }
  if (detected) {
    state.tag = _tag;
    state.anchor = _anchor;
    state.kind = 'sequence';
    state.result = _result;
    return true;
  }
  return false;
}
function readBlockMapping(state, nodeIndent, flowIndent) {
  var following,
    allowCompact,
    _line,
    _keyLine,
    _keyLineStart,
    _keyPos,
    _tag = state.tag,
    _anchor = state.anchor,
    _result = {},
    overridableKeys = Object.create(null),
    keyTag = null,
    keyNode = null,
    valueNode = null,
    atExplicitKey = false,
    detected = false,
    ch;
  if (state.firstTabInLine !== -1) return false;
  if (state.anchor !== null) state.anchorMap[state.anchor] = _result;
  ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    if (!atExplicitKey && state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, 'tab characters must not be used in indentation');
    }
    following = state.input.charCodeAt(state.position + 1);
    _line = state.line;
    if ((ch === 63 || ch === 58) && is_WS_OR_EOL(following)) {
      if (ch === 63) {
        if (atExplicitKey) {
          storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
          keyTag = keyNode = valueNode = null;
        }
        detected = true;
        atExplicitKey = true;
        allowCompact = true;
      } else if (atExplicitKey) {
        atExplicitKey = false;
        allowCompact = true;
      } else
        throwError(
          state,
          'incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line',
        );
      state.position += 1;
      ch = following;
    } else {
      _keyLine = state.line;
      _keyLineStart = state.lineStart;
      _keyPos = state.position;
      if (!composeNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) break;
      if (state.line === _line) {
        ch = state.input.charCodeAt(state.position);
        while (is_WHITE_SPACE(ch)) ch = state.input.charCodeAt(++state.position);
        if (ch === 58) {
          ch = state.input.charCodeAt(++state.position);
          if (!is_WS_OR_EOL(ch))
            throwError(
              state,
              'a whitespace character is expected after the key-value separator within a block mapping',
            );
          if (atExplicitKey) {
            storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
            keyTag = keyNode = valueNode = null;
          }
          detected = true;
          atExplicitKey = false;
          allowCompact = false;
          keyTag = state.tag;
          keyNode = state.result;
        } else if (detected) throwError(state, 'can not read an implicit mapping pair; a colon is missed');
        else {
          state.tag = _tag;
          state.anchor = _anchor;
          return true;
        }
      } else if (detected)
        throwError(state, 'can not read a block mapping entry; a multiline key may not be an implicit key');
      else {
        state.tag = _tag;
        state.anchor = _anchor;
        return true;
      }
    }
    if (state.line === _line || state.lineIndent > nodeIndent) {
      if (atExplicitKey) {
        _keyLine = state.line;
        _keyLineStart = state.lineStart;
        _keyPos = state.position;
      }
      if (composeNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, allowCompact))
        if (atExplicitKey) keyNode = state.result;
        else valueNode = state.result;
      if (!atExplicitKey) {
        storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _keyLine, _keyLineStart, _keyPos);
        keyTag = keyNode = valueNode = null;
      }
      skipSeparationSpace(state, true, -1);
      ch = state.input.charCodeAt(state.position);
    }
    if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0)
      throwError(state, 'bad indentation of a mapping entry');
    else if (state.lineIndent < nodeIndent) break;
  }
  if (atExplicitKey)
    storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
  if (detected) {
    state.tag = _tag;
    state.anchor = _anchor;
    state.kind = 'mapping';
    state.result = _result;
  }
  return detected;
}
function readTagProperty(state) {
  var _position,
    isVerbatim = false,
    isNamed = false,
    tagHandle,
    tagName,
    ch = state.input.charCodeAt(state.position);
  if (ch !== 33) return false;
  if (state.tag !== null) throwError(state, 'duplication of a tag property');
  ch = state.input.charCodeAt(++state.position);
  if (ch === 60) {
    isVerbatim = true;
    ch = state.input.charCodeAt(++state.position);
  } else if (ch === 33) {
    isNamed = true;
    tagHandle = '!!';
    ch = state.input.charCodeAt(++state.position);
  } else tagHandle = '!';
  _position = state.position;
  if (isVerbatim) {
    do ch = state.input.charCodeAt(++state.position);
    while (ch !== 0 && ch !== 62);
    if (state.position < state.length) {
      tagName = state.input.slice(_position, state.position);
      ch = state.input.charCodeAt(++state.position);
    } else throwError(state, 'unexpected end of the stream within a verbatim tag');
  } else {
    while (ch !== 0 && !is_WS_OR_EOL(ch)) {
      if (ch === 33)
        if (!isNamed) {
          tagHandle = state.input.slice(_position - 1, state.position + 1);
          if (!PATTERN_TAG_HANDLE.test(tagHandle)) throwError(state, 'named tag handle cannot contain such characters');
          isNamed = true;
          _position = state.position + 1;
        } else throwError(state, 'tag suffix cannot contain exclamation marks');
      ch = state.input.charCodeAt(++state.position);
    }
    tagName = state.input.slice(_position, state.position);
    if (PATTERN_FLOW_INDICATORS.test(tagName)) throwError(state, 'tag suffix cannot contain flow indicator characters');
  }
  if (tagName && !PATTERN_TAG_URI.test(tagName))
    throwError(state, 'tag name cannot contain such characters: ' + tagName);
  try {
    tagName = decodeURIComponent(tagName);
  } catch (err) {
    throwError(state, 'tag name is malformed: ' + tagName);
  }
  if (isVerbatim) state.tag = tagName;
  else if (_hasOwnProperty$1.call(state.tagMap, tagHandle)) state.tag = state.tagMap[tagHandle] + tagName;
  else if (tagHandle === '!') state.tag = '!' + tagName;
  else if (tagHandle === '!!') state.tag = 'tag:yaml.org,2002:' + tagName;
  else throwError(state, 'undeclared tag handle "' + tagHandle + '"');
  return true;
}
function readAnchorProperty(state) {
  var _position,
    ch = state.input.charCodeAt(state.position);
  if (ch !== 38) return false;
  if (state.anchor !== null) throwError(state, 'duplication of an anchor property');
  ch = state.input.charCodeAt(++state.position);
  _position = state.position;
  while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) ch = state.input.charCodeAt(++state.position);
  if (state.position === _position) throwError(state, 'name of an anchor node must contain at least one character');
  state.anchor = state.input.slice(_position, state.position);
  return true;
}
function readAlias(state) {
  var _position,
    alias,
    ch = state.input.charCodeAt(state.position);
  if (ch !== 42) return false;
  ch = state.input.charCodeAt(++state.position);
  _position = state.position;
  while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) ch = state.input.charCodeAt(++state.position);
  if (state.position === _position) throwError(state, 'name of an alias node must contain at least one character');
  alias = state.input.slice(_position, state.position);
  if (!_hasOwnProperty$1.call(state.anchorMap, alias)) throwError(state, 'unidentified alias "' + alias + '"');
  state.result = state.anchorMap[alias];
  skipSeparationSpace(state, true, -1);
  return true;
}
function composeNode(state, parentIndent, nodeContext, allowToSeek, allowCompact) {
  var allowBlockStyles,
    allowBlockScalars,
    allowBlockCollections,
    indentStatus = 1,
    atNewLine = false,
    hasContent = false,
    typeIndex,
    typeQuantity,
    typeList,
    type$1,
    flowIndent,
    blockIndent;
  if (state.listener !== null) state.listener('open', state);
  state.tag = null;
  state.anchor = null;
  state.kind = null;
  state.result = null;
  allowBlockStyles =
    allowBlockScalars =
    allowBlockCollections =
      CONTEXT_BLOCK_OUT === nodeContext || CONTEXT_BLOCK_IN === nodeContext;
  if (allowToSeek) {
    if (skipSeparationSpace(state, true, -1)) {
      atNewLine = true;
      if (state.lineIndent > parentIndent) indentStatus = 1;
      else if (state.lineIndent === parentIndent) indentStatus = 0;
      else if (state.lineIndent < parentIndent) indentStatus = -1;
    }
  }
  if (indentStatus === 1)
    while (readTagProperty(state) || readAnchorProperty(state))
      if (skipSeparationSpace(state, true, -1)) {
        atNewLine = true;
        allowBlockCollections = allowBlockStyles;
        if (state.lineIndent > parentIndent) indentStatus = 1;
        else if (state.lineIndent === parentIndent) indentStatus = 0;
        else if (state.lineIndent < parentIndent) indentStatus = -1;
      } else allowBlockCollections = false;
  if (allowBlockCollections) allowBlockCollections = atNewLine || allowCompact;
  if (indentStatus === 1 || CONTEXT_BLOCK_OUT === nodeContext) {
    if (CONTEXT_FLOW_IN === nodeContext || CONTEXT_FLOW_OUT === nodeContext) flowIndent = parentIndent;
    else flowIndent = parentIndent + 1;
    blockIndent = state.position - state.lineStart;
    if (indentStatus === 1)
      if (
        (allowBlockCollections &&
          (readBlockSequence(state, blockIndent) || readBlockMapping(state, blockIndent, flowIndent))) ||
        readFlowCollection(state, flowIndent)
      )
        hasContent = true;
      else {
        if (
          (allowBlockScalars && readBlockScalar(state, flowIndent)) ||
          readSingleQuotedScalar(state, flowIndent) ||
          readDoubleQuotedScalar(state, flowIndent)
        )
          hasContent = true;
        else if (readAlias(state)) {
          hasContent = true;
          if (state.tag !== null || state.anchor !== null)
            throwError(state, 'alias node should not have any properties');
        } else if (readPlainScalar(state, flowIndent, CONTEXT_FLOW_IN === nodeContext)) {
          hasContent = true;
          if (state.tag === null) state.tag = '?';
        }
        if (state.anchor !== null) state.anchorMap[state.anchor] = state.result;
      }
    else if (indentStatus === 0) hasContent = allowBlockCollections && readBlockSequence(state, blockIndent);
  }
  if (state.tag === null) {
    if (state.anchor !== null) state.anchorMap[state.anchor] = state.result;
  } else if (state.tag === '?') {
    if (state.result !== null && state.kind !== 'scalar')
      throwError(state, 'unacceptable node kind for !<?> tag; it should be "scalar", not "' + state.kind + '"');
    for (typeIndex = 0, typeQuantity = state.implicitTypes.length; typeIndex < typeQuantity; typeIndex += 1) {
      type$1 = state.implicitTypes[typeIndex];
      if (type$1.resolve(state.result)) {
        state.result = type$1.construct(state.result);
        state.tag = type$1.tag;
        if (state.anchor !== null) state.anchorMap[state.anchor] = state.result;
        break;
      }
    }
  } else if (state.tag !== '!') {
    if (_hasOwnProperty$1.call(state.typeMap[state.kind || 'fallback'], state.tag))
      type$1 = state.typeMap[state.kind || 'fallback'][state.tag];
    else {
      type$1 = null;
      typeList = state.typeMap.multi[state.kind || 'fallback'];
      for (typeIndex = 0, typeQuantity = typeList.length; typeIndex < typeQuantity; typeIndex += 1)
        if (state.tag.slice(0, typeList[typeIndex].tag.length) === typeList[typeIndex].tag) {
          type$1 = typeList[typeIndex];
          break;
        }
    }
    if (!type$1) throwError(state, 'unknown tag !<' + state.tag + '>');
    if (state.result !== null && type$1.kind !== state.kind)
      throwError(
        state,
        'unacceptable node kind for !<' +
          state.tag +
          '> tag; it should be "' +
          type$1.kind +
          '", not "' +
          state.kind +
          '"',
      );
    if (!type$1.resolve(state.result, state.tag))
      throwError(state, 'cannot resolve a node with !<' + state.tag + '> explicit tag');
    else {
      state.result = type$1.construct(state.result, state.tag);
      if (state.anchor !== null) state.anchorMap[state.anchor] = state.result;
    }
  }
  if (state.listener !== null) state.listener('close', state);
  return state.tag !== null || state.anchor !== null || hasContent;
}
function readDocument(state) {
  var documentStart = state.position,
    _position,
    directiveName,
    directiveArgs,
    hasDirectives = false,
    ch;
  state.version = null;
  state.checkLineBreaks = state.legacy;
  state.tagMap = Object.create(null);
  state.anchorMap = Object.create(null);
  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    skipSeparationSpace(state, true, -1);
    ch = state.input.charCodeAt(state.position);
    if (state.lineIndent > 0 || ch !== 37) break;
    hasDirectives = true;
    ch = state.input.charCodeAt(++state.position);
    _position = state.position;
    while (ch !== 0 && !is_WS_OR_EOL(ch)) ch = state.input.charCodeAt(++state.position);
    directiveName = state.input.slice(_position, state.position);
    directiveArgs = [];
    if (directiveName.length < 1) throwError(state, 'directive name must not be less than one character in length');
    while (ch !== 0) {
      while (is_WHITE_SPACE(ch)) ch = state.input.charCodeAt(++state.position);
      if (ch === 35) {
        do ch = state.input.charCodeAt(++state.position);
        while (ch !== 0 && !is_EOL(ch));
        break;
      }
      if (is_EOL(ch)) break;
      _position = state.position;
      while (ch !== 0 && !is_WS_OR_EOL(ch)) ch = state.input.charCodeAt(++state.position);
      directiveArgs.push(state.input.slice(_position, state.position));
    }
    if (ch !== 0) readLineBreak(state);
    if (_hasOwnProperty$1.call(directiveHandlers, directiveName))
      directiveHandlers[directiveName](state, directiveName, directiveArgs);
    else throwWarning(state, 'unknown document directive "' + directiveName + '"');
  }
  skipSeparationSpace(state, true, -1);
  if (
    state.lineIndent === 0 &&
    state.input.charCodeAt(state.position) === 45 &&
    state.input.charCodeAt(state.position + 1) === 45 &&
    state.input.charCodeAt(state.position + 2) === 45
  ) {
    state.position += 3;
    skipSeparationSpace(state, true, -1);
  } else if (hasDirectives) throwError(state, 'directives end mark is expected');
  composeNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, true);
  skipSeparationSpace(state, true, -1);
  if (state.checkLineBreaks && PATTERN_NON_ASCII_LINE_BREAKS.test(state.input.slice(documentStart, state.position)))
    throwWarning(state, 'non-ASCII line breaks are interpreted as content');
  state.documents.push(state.result);
  if (state.position === state.lineStart && testDocumentSeparator(state)) {
    if (state.input.charCodeAt(state.position) === 46) {
      state.position += 3;
      skipSeparationSpace(state, true, -1);
    }
    return;
  }
  if (state.position < state.length - 1) throwError(state, 'end of the stream or a document separator is expected');
  else return;
}
function loadDocuments(input, options) {
  input = String(input);
  options = options || {};
  if (input.length !== 0) {
    if (input.charCodeAt(input.length - 1) !== 10 && input.charCodeAt(input.length - 1) !== 13) input += '\n';
    if (input.charCodeAt(0) === 65279) input = input.slice(1);
  }
  var state = new State$1(input, options);
  var nullpos = input.indexOf('\0');
  if (nullpos !== -1) {
    state.position = nullpos;
    throwError(state, 'null byte is not allowed in input');
  }
  state.input += '\0';
  while (state.input.charCodeAt(state.position) === 32) {
    state.lineIndent += 1;
    state.position += 1;
  }
  while (state.position < state.length - 1) readDocument(state);
  return state.documents;
}
function loadAll$1(input, iterator, options) {
  if (iterator !== null && typeof iterator === 'object' && typeof options === 'undefined') {
    options = iterator;
    iterator = null;
  }
  var documents = loadDocuments(input, options);
  if (typeof iterator !== 'function') return documents;
  for (var index = 0, length = documents.length; index < length; index += 1) iterator(documents[index]);
}
function load$1(input, options) {
  var documents = loadDocuments(input, options);
  if (documents.length === 0) return;
  else if (documents.length === 1) return documents[0];
  throw new exception('expected a single document in the stream, but found more');
}
var loader = {
  loadAll: loadAll$1,
  load: load$1,
};
var _toString = Object.prototype.toString;
var _hasOwnProperty = Object.prototype.hasOwnProperty;
var CHAR_BOM = 65279;
var CHAR_TAB = 9;
var CHAR_LINE_FEED = 10;
var CHAR_CARRIAGE_RETURN = 13;
var CHAR_SPACE = 32;
var CHAR_EXCLAMATION = 33;
var CHAR_DOUBLE_QUOTE = 34;
var CHAR_SHARP = 35;
var CHAR_PERCENT = 37;
var CHAR_AMPERSAND = 38;
var CHAR_SINGLE_QUOTE = 39;
var CHAR_ASTERISK = 42;
var CHAR_COMMA = 44;
var CHAR_MINUS = 45;
var CHAR_COLON = 58;
var CHAR_EQUALS = 61;
var CHAR_GREATER_THAN = 62;
var CHAR_QUESTION = 63;
var CHAR_COMMERCIAL_AT = 64;
var CHAR_LEFT_SQUARE_BRACKET = 91;
var CHAR_RIGHT_SQUARE_BRACKET = 93;
var CHAR_GRAVE_ACCENT = 96;
var CHAR_LEFT_CURLY_BRACKET = 123;
var CHAR_VERTICAL_LINE = 124;
var CHAR_RIGHT_CURLY_BRACKET = 125;
var ESCAPE_SEQUENCES = {};
ESCAPE_SEQUENCES[0] = '\\0';
ESCAPE_SEQUENCES[7] = '\\a';
ESCAPE_SEQUENCES[8] = '\\b';
ESCAPE_SEQUENCES[9] = '\\t';
ESCAPE_SEQUENCES[10] = '\\n';
ESCAPE_SEQUENCES[11] = '\\v';
ESCAPE_SEQUENCES[12] = '\\f';
ESCAPE_SEQUENCES[13] = '\\r';
ESCAPE_SEQUENCES[27] = '\\e';
ESCAPE_SEQUENCES[34] = '\\"';
ESCAPE_SEQUENCES[92] = '\\\\';
ESCAPE_SEQUENCES[133] = '\\N';
ESCAPE_SEQUENCES[160] = '\\_';
ESCAPE_SEQUENCES[8232] = '\\L';
ESCAPE_SEQUENCES[8233] = '\\P';
var DEPRECATED_BOOLEANS_SYNTAX = [
  'y',
  'Y',
  'yes',
  'Yes',
  'YES',
  'on',
  'On',
  'ON',
  'n',
  'N',
  'no',
  'No',
  'NO',
  'off',
  'Off',
  'OFF',
];
var DEPRECATED_BASE60_SYNTAX = /^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$/;
function compileStyleMap(schema$1, map$1) {
  var result, keys, index, length, tag, style, type$1;
  if (map$1 === null) return {};
  result = {};
  keys = Object.keys(map$1);
  for (index = 0, length = keys.length; index < length; index += 1) {
    tag = keys[index];
    style = String(map$1[tag]);
    if (tag.slice(0, 2) === '!!') tag = 'tag:yaml.org,2002:' + tag.slice(2);
    type$1 = schema$1.compiledTypeMap['fallback'][tag];
    if (type$1 && _hasOwnProperty.call(type$1.styleAliases, style)) style = type$1.styleAliases[style];
    result[tag] = style;
  }
  return result;
}
function encodeHex(character) {
  var string = character.toString(16).toUpperCase(),
    handle,
    length;
  if (character <= 255) {
    handle = 'x';
    length = 2;
  } else if (character <= 65535) {
    handle = 'u';
    length = 4;
  } else if (character <= 4294967295) {
    handle = 'U';
    length = 8;
  } else throw new exception('code point within a string may not be greater than 0xFFFFFFFF');
  return '\\' + handle + common.repeat('0', length - string.length) + string;
}
var QUOTING_TYPE_SINGLE = 1,
  QUOTING_TYPE_DOUBLE = 2;
function State(options) {
  this.schema = options['schema'] || _default;
  this.indent = Math.max(1, options['indent'] || 2);
  this.noArrayIndent = options['noArrayIndent'] || false;
  this.skipInvalid = options['skipInvalid'] || false;
  this.flowLevel = common.isNothing(options['flowLevel']) ? -1 : options['flowLevel'];
  this.styleMap = compileStyleMap(this.schema, options['styles'] || null);
  this.sortKeys = options['sortKeys'] || false;
  this.lineWidth = options['lineWidth'] || 80;
  this.noRefs = options['noRefs'] || false;
  this.noCompatMode = options['noCompatMode'] || false;
  this.condenseFlow = options['condenseFlow'] || false;
  this.quotingType = options['quotingType'] === '"' ? QUOTING_TYPE_DOUBLE : QUOTING_TYPE_SINGLE;
  this.forceQuotes = options['forceQuotes'] || false;
  this.replacer = typeof options['replacer'] === 'function' ? options['replacer'] : null;
  this.implicitTypes = this.schema.compiledImplicit;
  this.explicitTypes = this.schema.compiledExplicit;
  this.tag = null;
  this.result = '';
  this.duplicates = [];
  this.usedDuplicates = null;
}
function indentString(string, spaces) {
  var ind = common.repeat(' ', spaces),
    position = 0,
    next = -1,
    result = '',
    line,
    length = string.length;
  while (position < length) {
    next = string.indexOf('\n', position);
    if (next === -1) {
      line = string.slice(position);
      position = length;
    } else {
      line = string.slice(position, next + 1);
      position = next + 1;
    }
    if (line.length && line !== '\n') result += ind;
    result += line;
  }
  return result;
}
function generateNextLine(state, level) {
  return '\n' + common.repeat(' ', state.indent * level);
}
function testImplicitResolving(state, str$1) {
  var index, length, type$1;
  for (index = 0, length = state.implicitTypes.length; index < length; index += 1) {
    type$1 = state.implicitTypes[index];
    if (type$1.resolve(str$1)) return true;
  }
  return false;
}
function isWhitespace(c) {
  return c === CHAR_SPACE || c === CHAR_TAB;
}
function isPrintable(c) {
  return (
    (32 <= c && c <= 126) ||
    (161 <= c && c <= 55295 && c !== 8232 && c !== 8233) ||
    (57344 <= c && c <= 65533 && c !== CHAR_BOM) ||
    (65536 <= c && c <= 1114111)
  );
}
function isNsCharOrWhitespace(c) {
  return isPrintable(c) && c !== CHAR_BOM && c !== CHAR_CARRIAGE_RETURN && c !== CHAR_LINE_FEED;
}
function isPlainSafe(c, prev, inblock) {
  var cIsNsCharOrWhitespace = isNsCharOrWhitespace(c);
  var cIsNsChar = cIsNsCharOrWhitespace && !isWhitespace(c);
  return (
    ((inblock
      ? cIsNsCharOrWhitespace
      : cIsNsCharOrWhitespace &&
        c !== CHAR_COMMA &&
        c !== CHAR_LEFT_SQUARE_BRACKET &&
        c !== CHAR_RIGHT_SQUARE_BRACKET &&
        c !== CHAR_LEFT_CURLY_BRACKET &&
        c !== CHAR_RIGHT_CURLY_BRACKET) &&
      c !== CHAR_SHARP &&
      !(prev === CHAR_COLON && !cIsNsChar)) ||
    (isNsCharOrWhitespace(prev) && !isWhitespace(prev) && c === CHAR_SHARP) ||
    (prev === CHAR_COLON && cIsNsChar)
  );
}
function isPlainSafeFirst(c) {
  return (
    isPrintable(c) &&
    c !== CHAR_BOM &&
    !isWhitespace(c) &&
    c !== CHAR_MINUS &&
    c !== CHAR_QUESTION &&
    c !== CHAR_COLON &&
    c !== CHAR_COMMA &&
    c !== CHAR_LEFT_SQUARE_BRACKET &&
    c !== CHAR_RIGHT_SQUARE_BRACKET &&
    c !== CHAR_LEFT_CURLY_BRACKET &&
    c !== CHAR_RIGHT_CURLY_BRACKET &&
    c !== CHAR_SHARP &&
    c !== CHAR_AMPERSAND &&
    c !== CHAR_ASTERISK &&
    c !== CHAR_EXCLAMATION &&
    c !== CHAR_VERTICAL_LINE &&
    c !== CHAR_EQUALS &&
    c !== CHAR_GREATER_THAN &&
    c !== CHAR_SINGLE_QUOTE &&
    c !== CHAR_DOUBLE_QUOTE &&
    c !== CHAR_PERCENT &&
    c !== CHAR_COMMERCIAL_AT &&
    c !== CHAR_GRAVE_ACCENT
  );
}
function isPlainSafeLast(c) {
  return !isWhitespace(c) && c !== CHAR_COLON;
}
function codePointAt(string, pos) {
  var first = string.charCodeAt(pos),
    second;
  if (first >= 55296 && first <= 56319 && pos + 1 < string.length) {
    second = string.charCodeAt(pos + 1);
    if (second >= 56320 && second <= 57343) return (first - 55296) * 1024 + second - 56320 + 65536;
  }
  return first;
}
function needIndentIndicator(string) {
  return /^\n* /.test(string);
}
var STYLE_PLAIN = 1,
  STYLE_SINGLE = 2,
  STYLE_LITERAL = 3,
  STYLE_FOLDED = 4,
  STYLE_DOUBLE = 5;
function chooseScalarStyle(
  string,
  singleLineOnly,
  indentPerLevel,
  lineWidth,
  testAmbiguousType,
  quotingType,
  forceQuotes,
  inblock,
) {
  var i$1;
  var char = 0;
  var prevChar = null;
  var hasLineBreak = false;
  var hasFoldableLine = false;
  var shouldTrackWidth = lineWidth !== -1;
  var previousLineBreak = -1;
  var plain = isPlainSafeFirst(codePointAt(string, 0)) && isPlainSafeLast(codePointAt(string, string.length - 1));
  if (singleLineOnly || forceQuotes)
    for (i$1 = 0; i$1 < string.length; char >= 65536 ? (i$1 += 2) : i$1++) {
      char = codePointAt(string, i$1);
      if (!isPrintable(char)) return STYLE_DOUBLE;
      plain = plain && isPlainSafe(char, prevChar, inblock);
      prevChar = char;
    }
  else {
    for (i$1 = 0; i$1 < string.length; char >= 65536 ? (i$1 += 2) : i$1++) {
      char = codePointAt(string, i$1);
      if (char === CHAR_LINE_FEED) {
        hasLineBreak = true;
        if (shouldTrackWidth) {
          hasFoldableLine =
            hasFoldableLine || (i$1 - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== ' ');
          previousLineBreak = i$1;
        }
      } else if (!isPrintable(char)) return STYLE_DOUBLE;
      plain = plain && isPlainSafe(char, prevChar, inblock);
      prevChar = char;
    }
    hasFoldableLine =
      hasFoldableLine ||
      (shouldTrackWidth && i$1 - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== ' ');
  }
  if (!hasLineBreak && !hasFoldableLine) {
    if (plain && !forceQuotes && !testAmbiguousType(string)) return STYLE_PLAIN;
    return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE;
  }
  if (indentPerLevel > 9 && needIndentIndicator(string)) return STYLE_DOUBLE;
  if (!forceQuotes) return hasFoldableLine ? STYLE_FOLDED : STYLE_LITERAL;
  return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE;
}
function writeScalar(state, string, level, iskey, inblock) {
  state.dump = (function () {
    if (string.length === 0) return state.quotingType === QUOTING_TYPE_DOUBLE ? '""' : "''";
    if (!state.noCompatMode) {
      if (DEPRECATED_BOOLEANS_SYNTAX.indexOf(string) !== -1 || DEPRECATED_BASE60_SYNTAX.test(string))
        return state.quotingType === QUOTING_TYPE_DOUBLE ? '"' + string + '"' : "'" + string + "'";
    }
    var indent = state.indent * Math.max(1, level);
    var lineWidth = state.lineWidth === -1 ? -1 : Math.max(Math.min(state.lineWidth, 40), state.lineWidth - indent);
    var singleLineOnly = iskey || (state.flowLevel > -1 && level >= state.flowLevel);
    function testAmbiguity(string$1) {
      return testImplicitResolving(state, string$1);
    }
    switch (
      chooseScalarStyle(
        string,
        singleLineOnly,
        state.indent,
        lineWidth,
        testAmbiguity,
        state.quotingType,
        state.forceQuotes && !iskey,
        inblock,
      )
    ) {
      case STYLE_PLAIN:
        return string;
      case STYLE_SINGLE:
        return "'" + string.replace(/'/g, "''") + "'";
      case STYLE_LITERAL:
        return '|' + blockHeader(string, state.indent) + dropEndingNewline(indentString(string, indent));
      case STYLE_FOLDED:
        return (
          '>' +
          blockHeader(string, state.indent) +
          dropEndingNewline(indentString(foldString(string, lineWidth), indent))
        );
      case STYLE_DOUBLE:
        return '"' + escapeString(string) + '"';
      default:
        throw new exception('impossible error: invalid scalar style');
    }
  })();
}
function blockHeader(string, indentPerLevel) {
  var indentIndicator = needIndentIndicator(string) ? String(indentPerLevel) : '';
  var clip = string[string.length - 1] === '\n';
  return (
    indentIndicator + (clip && (string[string.length - 2] === '\n' || string === '\n') ? '+' : clip ? '' : '-') + '\n'
  );
}
function dropEndingNewline(string) {
  return string[string.length - 1] === '\n' ? string.slice(0, -1) : string;
}
function foldString(string, width) {
  var lineRe = /(\n+)([^\n]*)/g;
  var result = (function () {
    var nextLF = string.indexOf('\n');
    nextLF = nextLF !== -1 ? nextLF : string.length;
    lineRe.lastIndex = nextLF;
    return foldLine(string.slice(0, nextLF), width);
  })();
  var prevMoreIndented = string[0] === '\n' || string[0] === ' ';
  var moreIndented;
  var match;
  while ((match = lineRe.exec(string))) {
    var prefix = match[1],
      line = match[2];
    moreIndented = line[0] === ' ';
    result += prefix + (!prevMoreIndented && !moreIndented && line !== '' ? '\n' : '') + foldLine(line, width);
    prevMoreIndented = moreIndented;
  }
  return result;
}
function foldLine(line, width) {
  if (line === '' || line[0] === ' ') return line;
  var breakRe = / [^ ]/g;
  var match;
  var start = 0,
    end,
    curr = 0,
    next = 0;
  var result = '';
  while ((match = breakRe.exec(line))) {
    next = match.index;
    if (next - start > width) {
      end = curr > start ? curr : next;
      result += '\n' + line.slice(start, end);
      start = end + 1;
    }
    curr = next;
  }
  result += '\n';
  if (line.length - start > width && curr > start) result += line.slice(start, curr) + '\n' + line.slice(curr + 1);
  else result += line.slice(start);
  return result.slice(1);
}
function escapeString(string) {
  var result = '';
  var char = 0;
  var escapeSeq;
  for (var i$1 = 0; i$1 < string.length; char >= 65536 ? (i$1 += 2) : i$1++) {
    char = codePointAt(string, i$1);
    escapeSeq = ESCAPE_SEQUENCES[char];
    if (!escapeSeq && isPrintable(char)) {
      result += string[i$1];
      if (char >= 65536) result += string[i$1 + 1];
    } else result += escapeSeq || encodeHex(char);
  }
  return result;
}
function writeFlowSequence(state, level, object) {
  var _result = '',
    _tag = state.tag,
    index,
    length,
    value;
  for (index = 0, length = object.length; index < length; index += 1) {
    value = object[index];
    if (state.replacer) value = state.replacer.call(object, String(index), value);
    if (
      writeNode(state, level, value, false, false) ||
      (typeof value === 'undefined' && writeNode(state, level, null, false, false))
    ) {
      if (_result !== '') _result += ',' + (!state.condenseFlow ? ' ' : '');
      _result += state.dump;
    }
  }
  state.tag = _tag;
  state.dump = '[' + _result + ']';
}
function writeBlockSequence(state, level, object, compact) {
  var _result = '',
    _tag = state.tag,
    index,
    length,
    value;
  for (index = 0, length = object.length; index < length; index += 1) {
    value = object[index];
    if (state.replacer) value = state.replacer.call(object, String(index), value);
    if (
      writeNode(state, level + 1, value, true, true, false, true) ||
      (typeof value === 'undefined' && writeNode(state, level + 1, null, true, true, false, true))
    ) {
      if (!compact || _result !== '') _result += generateNextLine(state, level);
      if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) _result += '-';
      else _result += '- ';
      _result += state.dump;
    }
  }
  state.tag = _tag;
  state.dump = _result || '[]';
}
function writeFlowMapping(state, level, object) {
  var _result = '',
    _tag = state.tag,
    objectKeyList = Object.keys(object),
    index,
    length,
    objectKey,
    objectValue,
    pairBuffer;
  for (index = 0, length = objectKeyList.length; index < length; index += 1) {
    pairBuffer = '';
    if (_result !== '') pairBuffer += ', ';
    if (state.condenseFlow) pairBuffer += '"';
    objectKey = objectKeyList[index];
    objectValue = object[objectKey];
    if (state.replacer) objectValue = state.replacer.call(object, objectKey, objectValue);
    if (!writeNode(state, level, objectKey, false, false)) continue;
    if (state.dump.length > 1024) pairBuffer += '? ';
    pairBuffer += state.dump + (state.condenseFlow ? '"' : '') + ':' + (state.condenseFlow ? '' : ' ');
    if (!writeNode(state, level, objectValue, false, false)) continue;
    pairBuffer += state.dump;
    _result += pairBuffer;
  }
  state.tag = _tag;
  state.dump = '{' + _result + '}';
}
function writeBlockMapping(state, level, object, compact) {
  var _result = '',
    _tag = state.tag,
    objectKeyList = Object.keys(object),
    index,
    length,
    objectKey,
    objectValue,
    explicitPair,
    pairBuffer;
  if (state.sortKeys === true) objectKeyList.sort();
  else if (typeof state.sortKeys === 'function') objectKeyList.sort(state.sortKeys);
  else if (state.sortKeys) throw new exception('sortKeys must be a boolean or a function');
  for (index = 0, length = objectKeyList.length; index < length; index += 1) {
    pairBuffer = '';
    if (!compact || _result !== '') pairBuffer += generateNextLine(state, level);
    objectKey = objectKeyList[index];
    objectValue = object[objectKey];
    if (state.replacer) objectValue = state.replacer.call(object, objectKey, objectValue);
    if (!writeNode(state, level + 1, objectKey, true, true, true)) continue;
    explicitPair = (state.tag !== null && state.tag !== '?') || (state.dump && state.dump.length > 1024);
    if (explicitPair)
      if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) pairBuffer += '?';
      else pairBuffer += '? ';
    pairBuffer += state.dump;
    if (explicitPair) pairBuffer += generateNextLine(state, level);
    if (!writeNode(state, level + 1, objectValue, true, explicitPair)) continue;
    if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) pairBuffer += ':';
    else pairBuffer += ': ';
    pairBuffer += state.dump;
    _result += pairBuffer;
  }
  state.tag = _tag;
  state.dump = _result || '{}';
}
function detectType(state, object, explicit) {
  var _result,
    typeList = explicit ? state.explicitTypes : state.implicitTypes,
    index,
    length,
    type$1,
    style;
  for (index = 0, length = typeList.length; index < length; index += 1) {
    type$1 = typeList[index];
    if (
      (type$1.instanceOf || type$1.predicate) &&
      (!type$1.instanceOf || (typeof object === 'object' && object instanceof type$1.instanceOf)) &&
      (!type$1.predicate || type$1.predicate(object))
    ) {
      if (explicit)
        if (type$1.multi && type$1.representName) state.tag = type$1.representName(object);
        else state.tag = type$1.tag;
      else state.tag = '?';
      if (type$1.represent) {
        style = state.styleMap[type$1.tag] || type$1.defaultStyle;
        if (_toString.call(type$1.represent) === '[object Function]') _result = type$1.represent(object, style);
        else if (_hasOwnProperty.call(type$1.represent, style)) _result = type$1.represent[style](object, style);
        else throw new exception('!<' + type$1.tag + '> tag resolver accepts not "' + style + '" style');
        state.dump = _result;
      }
      return true;
    }
  }
  return false;
}
function writeNode(state, level, object, block, compact, iskey, isblockseq) {
  state.tag = null;
  state.dump = object;
  if (!detectType(state, object, false)) detectType(state, object, true);
  var type$1 = _toString.call(state.dump);
  var inblock = block;
  var tagStr;
  if (block) block = state.flowLevel < 0 || state.flowLevel > level;
  var objectOrArray = type$1 === '[object Object]' || type$1 === '[object Array]',
    duplicateIndex,
    duplicate;
  if (objectOrArray) {
    duplicateIndex = state.duplicates.indexOf(object);
    duplicate = duplicateIndex !== -1;
  }
  if ((state.tag !== null && state.tag !== '?') || duplicate || (state.indent !== 2 && level > 0)) compact = false;
  if (duplicate && state.usedDuplicates[duplicateIndex]) state.dump = '*ref_' + duplicateIndex;
  else {
    if (objectOrArray && duplicate && !state.usedDuplicates[duplicateIndex])
      state.usedDuplicates[duplicateIndex] = true;
    if (type$1 === '[object Object]')
      if (block && Object.keys(state.dump).length !== 0) {
        writeBlockMapping(state, level, state.dump, compact);
        if (duplicate) state.dump = '&ref_' + duplicateIndex + state.dump;
      } else {
        writeFlowMapping(state, level, state.dump);
        if (duplicate) state.dump = '&ref_' + duplicateIndex + ' ' + state.dump;
      }
    else if (type$1 === '[object Array]')
      if (block && state.dump.length !== 0) {
        if (state.noArrayIndent && !isblockseq && level > 0) writeBlockSequence(state, level - 1, state.dump, compact);
        else writeBlockSequence(state, level, state.dump, compact);
        if (duplicate) state.dump = '&ref_' + duplicateIndex + state.dump;
      } else {
        writeFlowSequence(state, level, state.dump);
        if (duplicate) state.dump = '&ref_' + duplicateIndex + ' ' + state.dump;
      }
    else if (type$1 === '[object String]') {
      if (state.tag !== '?') writeScalar(state, state.dump, level, iskey, inblock);
    } else if (type$1 === '[object Undefined]') return false;
    else {
      if (state.skipInvalid) return false;
      throw new exception('unacceptable kind of an object to dump ' + type$1);
    }
    if (state.tag !== null && state.tag !== '?') {
      tagStr = encodeURI(state.tag[0] === '!' ? state.tag.slice(1) : state.tag).replace(/!/g, '%21');
      if (state.tag[0] === '!') tagStr = '!' + tagStr;
      else if (tagStr.slice(0, 18) === 'tag:yaml.org,2002:') tagStr = '!!' + tagStr.slice(18);
      else tagStr = '!<' + tagStr + '>';
      state.dump = tagStr + ' ' + state.dump;
    }
  }
  return true;
}
function getDuplicateReferences(object, state) {
  var objects = [],
    duplicatesIndexes = [],
    index,
    length;
  inspectNode(object, objects, duplicatesIndexes);
  for (index = 0, length = duplicatesIndexes.length; index < length; index += 1)
    state.duplicates.push(objects[duplicatesIndexes[index]]);
  state.usedDuplicates = new Array(length);
}
function inspectNode(object, objects, duplicatesIndexes) {
  var objectKeyList, index, length;
  if (object !== null && typeof object === 'object') {
    index = objects.indexOf(object);
    if (index !== -1) {
      if (duplicatesIndexes.indexOf(index) === -1) duplicatesIndexes.push(index);
    } else {
      objects.push(object);
      if (Array.isArray(object))
        for (index = 0, length = object.length; index < length; index += 1)
          inspectNode(object[index], objects, duplicatesIndexes);
      else {
        objectKeyList = Object.keys(object);
        for (index = 0, length = objectKeyList.length; index < length; index += 1)
          inspectNode(object[objectKeyList[index]], objects, duplicatesIndexes);
      }
    }
  }
}
function dump$1(input, options) {
  options = options || {};
  var state = new State(options);
  if (!state.noRefs) getDuplicateReferences(input, state);
  var value = input;
  if (state.replacer) value = state.replacer.call({ '': value }, '', value);
  if (writeNode(state, 0, value, true, true)) return state.dump + '\n';
  return '';
}
var dumper = { dump: dump$1 };
function renamed(from, to) {
  return function () {
    throw new Error(
      'Function yaml.' + from + ' is removed in js-yaml 4. Use yaml.' + to + ' instead, which is now safe by default.',
    );
  };
}
var load = loader.load;
var loadAll = loader.loadAll;
var dump = dumper.dump;
var safeLoad = renamed('safeLoad', 'load');
var safeLoadAll = renamed('safeLoadAll', 'loadAll');
var safeDump = renamed('safeDump', 'dump');

//#endregion
//#region src/repos/lib.ts
function findRoot() {
  if (process.env['TAU_ROOT']) {
    const envRoot = process.env['TAU_ROOT'];
    if (existsSync(join(envRoot, 'repos.yaml'))) return envRoot;
  }
  let directory = process.cwd();
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, 'repos.yaml'))) return directory;
    directory = dirname(directory);
  }
  throw new Error('Could not find repos.yaml. Run from the workspace root or set TAU_ROOT.');
}
function readManifest(root) {
  const resolvedRoot = root ?? findRoot();
  return {
    manifest: load(readFileSync(join(resolvedRoot, 'repos.yaml'), 'utf8')),
    root: resolvedRoot,
  };
}
function writeManifest(manifest, root) {
  writeFileSync(
    join(root ?? findRoot(), 'repos.yaml'),
    dump(manifest, {
      lineWidth: -1,
      noRefs: true,
      quotingType: "'",
      forceQuotes: false,
    }),
    'utf8',
  );
}
function repoUrl(ownerRepo) {
  return `https://github.com/${ownerRepo}.git`;
}
function parseOwnerRepo(url) {
  return /github\.com[/:](?<ownerRepo>[^/]+\/[^./]+?)(?:\.git)?$/.exec(url)?.groups?.['ownerRepo'];
}
function repoPath(context) {
  const { name, repo, manifest, root } = context;
  const relative = repo.path ?? name;
  return resolve(root, manifest.repos_dir, relative);
}
function resolveRepos(manifest, filter) {
  if (!filter || filter.all) return Object.entries(manifest.repos);
  if (filter.name) {
    const repo = manifest.repos[filter.name];
    if (!repo) throw new Error(`Repo "${filter.name}" not found in manifest.`);
    return [[filter.name, repo]];
  }
  if (filter.group) {
    const group = manifest.groups[filter.group];
    if (!group)
      throw new Error(`Group "${filter.group}" not found. Available: ${Object.keys(manifest.groups).join(', ')}`);
    return group.repos
      .map((name) => {
        const repo = manifest.repos[name];
        if (!repo) {
          console.warn(`Warning: repo "${name}" in group "${filter.group}" not found in manifest.`);
          return;
        }
        return [name, repo];
      })
      .filter((entry) => entry !== void 0);
  }
  return Object.entries(manifest.repos);
}
function isCloned(context) {
  return existsSync(join(repoPath(context), '.git'));
}
function gitExec(context, args) {
  const directory = repoPath(context);
  return execSync(['git', ...args].join(' '), {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
function getRepoStatus(context) {
  const { name, repo } = context;
  if (!isCloned(context))
    return {
      name,
      cloned: false,
    };
  try {
    const branch = gitExec(context, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const dirty = gitExec(context, ['status', '--porcelain']).length > 0;
    let ahead = 0;
    let behind = 0;
    try {
      const parts = gitExec(context, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]).split('	');
      behind = Number.parseInt(parts[0] ?? '0', 10);
      ahead = Number.parseInt(parts[1] ?? '0', 10);
    } catch {}
    let upstreamAhead;
    if (repo.fork)
      try {
        const uaOutput = gitExec(context, ['rev-list', '--count', `HEAD..upstream/${repo.branch ?? branch}`]);
        upstreamAhead = Number.parseInt(uaOutput, 10);
      } catch {}
    const lastActivity = getLastActivity(context);
    let pinnedCommit;
    let atPinnedCommit;
    if (repo.commit) {
      pinnedCommit = repo.commit;
      try {
        const head = gitExec(context, ['rev-parse', 'HEAD']);
        atPinnedCommit = head.startsWith(repo.commit) || repo.commit.startsWith(head);
      } catch {
        atPinnedCommit = false;
      }
    }
    return {
      name,
      cloned: true,
      branch,
      dirty,
      ahead,
      behind,
      upstreamAhead,
      lastActivity,
      pinnedCommit,
      atPinnedCommit,
    };
  } catch {
    return {
      name,
      cloned: true,
    };
  }
}
function getLastActivity(context) {
  if (!isCloned(context)) return;
  try {
    const ts = gitExec(context, ['log', '-1', '--format=%ct']);
    return Number.parseInt(ts, 10);
  } catch {
    return;
  }
}
function fetchRepoDescription(upstream) {
  try {
    return (
      execSync(`gh repo view ${upstream} --json description -q .description`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim() || void 0
    );
  } catch {
    return;
  }
}
function cloneRepo(context) {
  const { name, repo, manifest, root } = context;
  const directory = repoPath(context);
  if (existsSync(join(directory, '.git')))
    return {
      action: 'skipped',
      message: `${name}: already cloned`,
    };
  if (!repo.description) {
    const description = fetchRepoDescription(repo.upstream);
    if (description) {
      repo.description = description;
      writeManifest(manifest, root);
    }
  }
  const args = ['git', 'clone', repo.fork ? repoUrl(repo.fork) : repoUrl(repo.upstream), directory];
  if (repo.shallow && !repo.commit) args.splice(1, 0, '--depth', '1');
  if (repo.branch) args.splice(1, 0, '--branch', repo.branch);
  execSync(args.join(' '), { stdio: 'inherit' });
  if (repo.fork) execSync(`git -C ${directory} remote add upstream ${repoUrl(repo.upstream)}`, { stdio: 'inherit' });
  if (repo.commit) execSync(`git -C ${directory} checkout ${repo.commit}`, { stdio: 'inherit' });
  return {
    action: 'cloned',
    message: `${name}: cloned`,
  };
}
function syncRepo(context) {
  const { name, repo } = context;
  if (!isCloned(context))
    return {
      ok: false,
      message: `${name}: not cloned`,
    };
  try {
    gitExec(context, ['fetch', '--all', '--prune']);
    if (repo.commit) {
      const currentHead = gitExec(context, ['rev-parse', 'HEAD']);
      if (currentHead.startsWith(repo.commit) || repo.commit.startsWith(currentHead))
        return {
          ok: true,
          message: `${name}: already at pinned commit ${repo.commit.slice(0, 7)}`,
        };
      gitExec(context, ['checkout', repo.commit]);
      return {
        ok: true,
        message: `${name}: checked out pinned commit ${repo.commit.slice(0, 7)}`,
      };
    }
    try {
      gitExec(context, ['pull', '--ff-only']);
    } catch {
      return {
        ok: false,
        message: `${name}: fetch ok, pull --ff-only failed (diverged?)`,
      };
    }
    return {
      ok: true,
      message: `${name}: synced`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `${name}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
function forkRepo(name, manifest, root) {
  const repo = manifest.repos[name];
  if (!repo)
    return {
      ok: false,
      message: `Repo "${name}" not found in manifest.`,
    };
  if (repo.fork)
    return {
      ok: false,
      message: `${name}: already forked to ${repo.fork}`,
    };
  const repoName = repo.upstream.split('/')[1];
  const forkSlug = `${manifest.owner}/${repoName}`;
  try {
    execSync(`gh repo fork ${repo.upstream} --org ${manifest.owner} --clone=false`, { stdio: 'inherit' });
  } catch {}
  repo.fork = forkSlug;
  writeManifest(manifest, root);
  const context = {
    name,
    repo,
    manifest,
    root,
  };
  if (isCloned(context)) {
    const directory = repoPath(context);
    try {
      execSync(`git -C ${directory} remote rename origin upstream`, { stdio: 'pipe' });
    } catch {}
    try {
      execSync(`git -C ${directory} remote add origin ${repoUrl(forkSlug)}`, { stdio: 'pipe' });
    } catch {
      execSync(`git -C ${directory} remote set-url origin ${repoUrl(forkSlug)}`, { stdio: 'pipe' });
    }
  }
  return {
    ok: true,
    message: `${name}: forked to ${forkSlug}`,
  };
}
function unforkRepo(name, manifest, root) {
  const repo = manifest.repos[name];
  if (!repo)
    return {
      ok: false,
      message: `Repo "${name}" not found in manifest.`,
    };
  if (!repo.fork)
    return {
      ok: false,
      message: `${name}: not forked`,
    };
  const context = {
    name,
    repo,
    manifest,
    root,
  };
  if (isCloned(context)) {
    const directory = repoPath(context);
    try {
      execSync(`git -C ${directory} remote remove origin`, { stdio: 'pipe' });
      execSync(`git -C ${directory} remote rename upstream origin`, { stdio: 'pipe' });
    } catch {}
  }
  delete repo.fork;
  writeManifest(manifest, root);
  return {
    ok: true,
    message: `${name}: unforked (upstream only)`,
  };
}

//#endregion
//#region src/repos/commands.ts
const shortFlagMap = {
  g: 'group',
  b: 'branch',
  c: 'commit',
  d: 'description',
  p: 'path',
};
function parseArgs(argv) {
  const command$1 = argv[0] ?? '';
  const positional = [];
  const flags = {};
  let i$1 = 1;
  while (i$1 < argv.length) {
    const argument = argv[i$1];
    if (argument === '--') {
      positional.push(...argv.slice(i$1 + 1));
      break;
    }
    if (argument.startsWith('--')) {
      const key = argument.slice(2);
      const next = argv[i$1 + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i$1 += 2;
      } else {
        flags[key] = true;
        i$1 += 1;
      }
    } else if (argument.startsWith('-') && argument.length === 2) {
      const short = argument[1];
      const longKey = shortFlagMap[short] ?? short;
      const next = argv[i$1 + 1];
      if (next && !next.startsWith('-')) {
        flags[longKey] = next;
        i$1 += 2;
      } else {
        flags[longKey] = true;
        i$1 += 1;
      }
    } else {
      positional.push(argument);
      i$1 += 1;
    }
  }
  return {
    command: command$1,
    positional,
    flags,
  };
}
function getFilter(positional, flags) {
  if (flags['all']) return { all: true };
  if (typeof flags['group'] === 'string') return { group: flags['group'] };
  if (positional.length > 0) return { name: positional[0] };
  return { all: true };
}
function cmdClone(positional, flags) {
  const { manifest, root } = readManifest();
  const repos = resolveRepos(manifest, getFilter(positional, flags));
  const results = [];
  for (const [name, repo] of repos) {
    const result = cloneRepo({
      name,
      repo,
      manifest,
      root,
    });
    results.push({
      name,
      ...result,
    });
    console.log(result.message);
  }
  if (flags['json']) console.log(JSON.stringify(results, void 0, 2));
}
function cmdSync(positional, flags) {
  const { manifest, root } = readManifest();
  const repos = resolveRepos(manifest, getFilter(positional, flags));
  const results = [];
  for (const [name, repo] of repos) {
    if (
      !isCloned({
        name,
        repo,
        manifest,
        root,
      })
    )
      continue;
    const result = syncRepo({
      name,
      repo,
      manifest,
      root,
    });
    results.push({
      name,
      ...result,
    });
    console.log(result.message);
  }
  if (flags['json']) console.log(JSON.stringify(results, void 0, 2));
}
function cmdStatus(positional, flags) {
  const { manifest, root } = readManifest();
  const repos = resolveRepos(manifest, getFilter(positional, flags));
  const statuses = [];
  for (const [name, repo] of repos)
    statuses.push(
      getRepoStatus({
        name,
        repo,
        manifest,
        root,
      }),
    );
  if (flags['json']) {
    console.log(JSON.stringify(statuses, void 0, 2));
    return;
  }
  const nameWidth = Math.max(...statuses.map((s) => s.name.length), 4);
  console.log(`${'NAME'.padEnd(nameWidth)}  STATUS   BRANCH               DIRTY  AHEAD  BEHIND  PINNED`);
  console.log('─'.repeat(nameWidth + 63));
  for (const s of statuses) {
    const status = s.cloned ? 'cloned' : '─';
    const branch = s.branch ?? '─';
    const dirty = s.dirty ? 'yes' : s.cloned ? 'no' : '─';
    const ahead = s.ahead === void 0 ? '─' : String(s.ahead);
    const behind = s.behind === void 0 ? '─' : String(s.behind);
    const pinned = s.pinnedCommit
      ? s.atPinnedCommit
        ? `✓ ${s.pinnedCommit.slice(0, 7)}`
        : `✗ ${s.pinnedCommit.slice(0, 7)}`
      : '─';
    console.log(
      `${s.name.padEnd(nameWidth)}  ${status.padEnd(7)}  ${branch.padEnd(20)} ${dirty.padEnd(6)} ${ahead.padEnd(6)} ${behind.padEnd(7)} ${pinned}`,
    );
  }
}
function cmdList(flags) {
  const { manifest, root } = readManifest();
  if (flags['groups']) {
    if (flags['json']) {
      console.log(JSON.stringify(manifest.groups, void 0, 2));
      return;
    }
    for (const [name, group] of Object.entries(manifest.groups)) {
      console.log(`${name}: ${group.description ?? ''}`);
      for (const repoName of group.repos) {
        const clonedFlag = manifest.repos[repoName]
          ? isCloned({
              name: repoName,
              repo: manifest.repos[repoName],
              manifest,
              root,
            })
            ? '✓'
            : '·'
          : '?';
        console.log(`  ${clonedFlag} ${repoName}`);
      }
      console.log();
    }
    return;
  }
  const entries = Object.entries(manifest.repos);
  if (flags['json']) {
    const data = entries.map(([name, repo]) => ({
      name,
      upstream: repo.upstream,
      fork: repo.fork,
      branch: repo.branch,
      commit: repo.commit,
      description: repo.description,
      cloned: isCloned({
        name,
        repo,
        manifest,
        root,
      }),
      path: repo.path ?? name,
    }));
    if (flags['cloned'])
      console.log(
        JSON.stringify(
          data.filter((d) => d.cloned),
          void 0,
          2,
        ),
      );
    else console.log(JSON.stringify(data, void 0, 2));
    return;
  }
  const nameWidth = Math.max(...entries.map(([n]) => n.length), 4);
  console.log(`${'NAME'.padEnd(nameWidth)}  CLN  ORIGIN                    UPSTREAM                  BRANCH`);
  console.log('─'.repeat(nameWidth + 70));
  for (const [name, repo] of entries) {
    if (
      flags['cloned'] &&
      !isCloned({
        name,
        repo,
        manifest,
        root,
      })
    )
      continue;
    const clonedFlag = isCloned({
      name,
      repo,
      manifest,
      root,
    })
      ? '✓'
      : '·';
    const origin = repo.fork ?? repo.upstream;
    const upstream = repo.fork ? `← ${repo.upstream}` : '─';
    const branch = repo.branch ?? '─';
    console.log(`${name.padEnd(nameWidth)}   ${clonedFlag}   ${origin.padEnd(24)}  ${upstream.padEnd(24)}  ${branch}`);
  }
}
function cmdExec(positional, flags) {
  const { manifest, root } = readManifest();
  const repos = resolveRepos(manifest, getFilter([], flags));
  const cmd = positional.join(' ');
  if (!cmd) throw new Error('Usage: repos exec [--group G] [--all] -- <command>');
  for (const [name, repo] of repos) {
    if (
      !isCloned({
        name,
        repo,
        manifest,
        root,
      })
    )
      continue;
    const directory = repoPath({
      name,
      repo,
      manifest,
      root,
    });
    console.log(`\n=== ${name} ===`);
    try {
      execSync(cmd, {
        cwd: directory,
        stdio: 'inherit',
      });
    } catch {
      console.error(`  Command failed in ${name}`);
    }
  }
}
function cmdFork(positional) {
  const name = positional[0];
  if (!name) throw new Error('Usage: repos fork <name>');
  const { manifest, root } = readManifest();
  const result = forkRepo(name, manifest, root);
  console.log(result.message);
  if (!result.ok) throw new Error(result.message);
}
function cmdUnfork(positional) {
  const name = positional[0];
  if (!name) throw new Error('Usage: repos unfork <name>');
  const { manifest, root } = readManifest();
  const result = unforkRepo(name, manifest, root);
  console.log(result.message);
  if (!result.ok) throw new Error(result.message);
}
function cmdAdd(positional, flags) {
  const raw = positional[0];
  if (!raw)
    throw new Error(
      'Usage: repos add <owner/repo | github-url> [-g group] [-b branch] [-d description] [--shallow] [--clone]',
    );
  const slug = raw.includes('://') ? parseOwnerRepo(raw) : raw;
  if (!slug?.includes('/'))
    throw new Error(`Could not parse repo slug from "${raw}". Expected owner/repo or a GitHub URL.`);
  const repoName = slug.split('/')[1];
  const { manifest, root } = readManifest();
  if (manifest.repos[repoName]) throw new Error(`Repo "${repoName}" already exists in manifest.`);
  let description;
  if (typeof flags['description'] === 'string') ({ description } = flags);
  else
    try {
      description =
        execSync(`gh repo view ${slug} --json description -q .description`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim() || void 0;
    } catch {}
  const config = {
    upstream: slug,
    ...(typeof flags['branch'] === 'string' && { branch: flags['branch'] }),
    ...(typeof flags['commit'] === 'string' && { commit: flags['commit'] }),
    ...(description && { description }),
    ...(typeof flags['path'] === 'string' && { path: flags['path'] }),
    ...(flags['shallow'] && { shallow: true }),
  };
  manifest.repos[repoName] = config;
  const groupName = typeof flags['group'] === 'string' ? flags['group'] : void 0;
  if (groupName) {
    manifest.groups[groupName] ??= { repos: [] };
    if (!manifest.groups[groupName].repos.includes(repoName)) manifest.groups[groupName].repos.push(repoName);
  }
  writeManifest(manifest, root);
  console.log(`✓ Added ${repoName} (${slug})`);
  if (groupName) console.log(`  → added to group "${groupName}"`);
  if (flags['clone']) {
    const result = cloneRepo({
      name: repoName,
      repo: manifest.repos[repoName],
      manifest,
      root,
    });
    console.log(result.message);
  }
}
function cmdRemove(positional) {
  const name = positional[0];
  if (!name) throw new Error('Usage: repos remove <name>');
  const { manifest, root } = readManifest();
  if (!manifest.repos[name]) throw new Error(`Repo "${name}" not found in manifest.`);
  const { [name]: _, ...remainingRepos } = manifest.repos;
  manifest.repos = remainingRepos;
  for (const group of Object.values(manifest.groups)) {
    const index = group.repos.indexOf(name);
    if (index !== -1) group.repos.splice(index, 1);
  }
  writeManifest(manifest, root);
  console.log(`✓ Removed ${name} from manifest`);
}
const helpText = `
Usage: repos <command> [options]

Commands:
  add    <owner/repo> [-g group] [-b branch] [-c commit] [-d desc] [--shallow] [--clone]
  remove <name>                               Remove repo from manifest
  clone  [name] [--group G] [--all]           Clone repos
  sync   [name] [--group G] [--all]           Pull latest / checkout pinned commit
  status [name] [--group G] [--all] [--json]  Show repo status
  list   [--groups] [--cloned] [--json]       List repos/groups
  exec   [--group G] [--all] -- <cmd>         Run command across repos
  fork   <name>                               Fork repo to owner org
  unfork <name>                               Remove fork config

Short flags: -g (group) -b (branch) -c (commit) -d (description) -p (path)

Run without arguments for interactive TUI.
`.trim();
function run(argv) {
  const { command: command$1, positional, flags } = parseArgs(argv);
  switch (command$1) {
    case 'add':
      cmdAdd(positional, flags);
      break;
    case 'remove':
    case 'rm':
      cmdRemove(positional);
      break;
    case 'clone':
      cmdClone(positional, flags);
      break;
    case 'sync':
      cmdSync(positional, flags);
      break;
    case 'status':
      cmdStatus(positional, flags);
      break;
    case 'list':
      cmdList(flags);
      break;
    case 'exec':
      cmdExec(positional, flags);
      break;
    case 'fork':
      cmdFork(positional);
      break;
    case 'unfork':
      cmdUnfork(positional);
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(helpText);
      break;
    default:
      console.error(`Unknown command: ${command$1}\n`);
      console.log(helpText);
      throw new Error(`Unknown command: ${command$1}`);
  }
}

//#endregion
//#region src/repos/repos.ts
const [command] = process.argv.slice(2);
if (command) run(process.argv.slice(2));
else {
  const tuiPath = join(dirname(fileURLToPath(import.meta.url)), 'repos-tui.js');
  if (!existsSync(tuiPath)) {
    console.error('TUI not available. Build first: pnpm nx build scripts');
    console.error('Or use CLI mode: pnpm repos help');
    process.exit(1);
  }
  (await import(tuiPath)).launch();
}

//#endregion
export {};
