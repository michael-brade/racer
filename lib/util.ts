import deepIs from 'deep-is';

var isServer = process.title !== 'browser';
export {isServer};

export {asyncGroup};
export {castSegments};
export {contains};
export {copy};
export {copyObject};
export {deepCopy};
export {deepIs as deepEqual};
export {equal};
export {equalsNaN};
export {isArrayIndex};
export {lookup};
export {mergeInto};
export {mayImpact};
export {mayImpactAny};
export {serverRequire};
export {serverUse};
export {use};

function asyncGroup(cb): () => (err?: any) => void {
  var group = new AsyncGroup(cb);
  return function asyncGroupAdd() {
    return group.add();
  };
}

/**
 * @constructor
 * @param {Function} cb(err)
 */
class AsyncGroup {
  constructor(
    private cb,
    private isDone: boolean = false,
    private count: number = 0
  ) { }

  add(): (err?: any) => void {
    this.count++;
    var self = this;
    return function(err?) {
      self.count--;
      if (self.isDone) return;
      if (err) {
        self.isDone = true;
        self.cb(err);
        return;
      }
      if (self.count > 0) return;
      self.isDone = true;
      self.cb();
    };
  }
}

function castSegments(segments: (string|number)[]): (string|number)[] {
  // Cast number path segments from strings to numbers
  for (var i = segments.length; i--; ) {
    var segment = segments[i];
    if (typeof segment === 'string' && isArrayIndex(segment)) {
      segments[i] = +segment;
    }
  }
  return segments;
}

function contains(segments: string[], testSegments: string[]) {
  for (var i = 0; i < segments.length; i++) {
    if (segments[i] !== testSegments[i]) return false;
  }
  return true;
}

function copy(value) {
  if (value instanceof Date) return new Date(value);
  if (typeof value === 'object') {
    if (value === null) return null;
    if (Array.isArray(value)) return value.slice();
    return copyObject(value);
  }
  return value;
}

function copyObject(object) {
  var out = new object.constructor();
  for (var key in object) {
    if (object.hasOwnProperty(key)) {
      out[key] = object[key];
    }
  }
  return out;
}

function deepCopy(value) {
  if (value instanceof Date) return new Date(value);
  if (typeof value === 'object') {
    if (value === null) return null;
    if (Array.isArray(value)) {
      var array = [];
      for (var i = value.length; i--; ) {
        array[i] = deepCopy(value[i]);
      }
      return array;
    }
    var object = new value.constructor();
    for (var key in value) {
      if (value.hasOwnProperty(key)) {
        object[key] = deepCopy(value[key]);
      }
    }
    return object;
  }
  return value;
}

function equal(a, b) {
  return (a === b) || (equalsNaN(a) && equalsNaN(b));
}

function equalsNaN(x) {
  // eslint-disable-next-line no-self-compare
  return x !== x;
}

function isArrayIndex(segment) {
  return (/^[0-9]+$/).test(segment);
}

function lookup(segments: string[], value) {
  if (!segments) return value;

  for (var i = 0, len = segments.length; i < len; i++) {
    if (value == null) return value;
    value = value[segments[i]];
  }
  return value;
}

function mayImpactAny(segmentsList, testSegments) {
  for (var i = 0, len = segmentsList.length; i < len; i++) {
    if (mayImpact(segmentsList[i], testSegments)) return true;
  }
  return false;
}

function mayImpact(segments, testSegments) {
  var len = Math.min(segments.length, testSegments.length);
  for (var i = 0; i < len; i++) {
    if (segments[i] !== testSegments[i]) return false;
  }
  return true;
}

function mergeInto(to, from) {
  for (var key in from) {
    to[key] = from[key];
  }
  return to;
}

function serverRequire(module, id) {
  if (!isServer) return;
  return module.require(id);
}

function serverUse(module, id, options) {
  if (!isServer) return this;
  var plugin = module.require(id);
  return this.use(plugin, options);
}

function use(plugin, options) {
  // Don't include a plugin more than once
  var plugins = this._plugins || (this._plugins = []);
  if (plugins.indexOf(plugin) === -1) {
    plugins.push(plugin);
    plugin(this, options);
  }
  return this;
}
