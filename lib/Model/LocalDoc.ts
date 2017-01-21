import Doc from './Doc';
import util from '../util';


export default class LocalDoc extends Doc {
  constructor(model, collectionName, id, data) {
    super(model, collectionName, id);
    this.data = data;
    this._updateCollectionData();
  }

  _updateCollectionData() {
    this.collectionData[this.id] = this.data;
  }

  create(value, cb) {
    if (this.data !== undefined) {
      const message = this._errorMessage('create on local document with data', null, this.data);
      const err = new Error(message);
      return cb(err);
    }
    this.data = value;
    this._updateCollectionData();
    cb();
  }

  set(segments, value, cb) {
    function set(node, key) {
      const previous = node[key];
      node[key] = value;
      return previous;
    }
    return this._apply(segments, set, cb);
  }

  del(segments, cb) {
    // Don't do anything if the value is already undefined, since
    // apply creates objects as it traverses, and the del method
    // should not create anything
    const previous = this.get(segments);
    if (previous === undefined) {
      cb();
      return;
    }
    function del(node, key) {
      delete node[key];
      return previous;
    }
    return this._apply(segments, del, cb);
  }

  increment(segments, byNumber, cb) {
    const self = this;
    function validate(value) {
      if (typeof value === 'number' || value == null) return;
      return new TypeError(self._errorMessage(
        'increment on non-number', segments, value
      ));
    }
    function increment(node, key) {
      const value = (node[key] || 0) + byNumber;
      node[key] = value;
      return value;
    }
    return this._validatedApply(segments, validate, increment, cb);
  }

  push(segments, value, cb) {
    function push(arr) {
      return arr.push(value);
    }
    return this._arrayApply(segments, push, cb);
  }

  unshift(segments, value, cb) {
    function unshift(arr) {
      return arr.unshift(value);
    }
    return this._arrayApply(segments, unshift, cb);
  }

  insert(segments, index, values, cb) {
    function insert(arr) {
      arr.splice.apply(arr, [index, 0].concat(values));
      return arr.length;
    }
    return this._arrayApply(segments, insert, cb);
  }

  pop(segments, cb) {
    function pop(arr) {
      return arr.pop();
    }
    return this._arrayApply(segments, pop, cb);
  }

  shift(segments, cb) {
    function shift(arr) {
      return arr.shift();
    }
    return this._arrayApply(segments, shift, cb);
  }

  remove(segments, index, howMany, cb) {
    function remove(arr) {
      return arr.splice(index, howMany);
    }
    return this._arrayApply(segments, remove, cb);
  }

  move(segments, from, to, howMany, cb) {
    function move(arr) {
      // Remove from old location
      const values = arr.splice(from, howMany);
      // Insert in new location
      arr.splice.apply(arr, [to, 0].concat(values));
      return values;
    }
    return this._arrayApply(segments, move, cb);
  }

  stringInsert(segments, index, value, cb) {
    const self = this;
    function validate(value) {
      if (typeof value === 'string' || value == null) return;
      return new TypeError(self._errorMessage(
        'stringInsert on non-string', segments, value
      ));
    }
    function stringInsert(node, key) {
      const previous = node[key];
      if (previous == null) {
        node[key] = value;
        return previous;
      }
      node[key] = previous.slice(0, index) + value + previous.slice(index);
      return previous;
    }
    return this._validatedApply(segments, validate, stringInsert, cb);
  }

  stringRemove(segments, index, howMany, cb) {
    const self = this;
    function validate(value) {
      if (typeof value === 'string' || value == null) return;
      return new TypeError(self._errorMessage(
        'stringRemove on non-string', segments, value
      ));
    }
    function stringRemove(node, key) {
      const previous = node[key];
      if (previous == null) return previous;
      if (index < 0) index += previous.length;
      node[key] = previous.slice(0, index) + previous.slice(index + howMany);
      return previous;
    }
    return this._validatedApply(segments, validate, stringRemove, cb);
  }

  get(segments) {
    return util.lookup(segments, this.data);
  }

  /**
   * @param {Array} segments is the array representing a path
   * @param {Function} fn(node, key) applies a mutation on node[key]
   * @return {Object} returns the return value of fn(node, key)
   */
  _createImplied(segments, fn) {
    let node = this;
    let key = 'data';
    let i = 0;
    let nextKey = segments[i++];
    while (nextKey != null) {
      // Get or create implied object or array
      node = node[key] || (node[key] = /^\d+$/.test(nextKey) ? [] : {});
      key = nextKey;
      nextKey = segments[i++];
    }
    return fn(node, key);
  }

  _apply(segments, fn, cb) {
    const out = this._createImplied(segments, fn);
    this._updateCollectionData();
    cb();
    return out;
  }

  _validatedApply(segments, validate, fn, cb) {
    const out = this._createImplied(segments, (node, key) => {
      const err = validate(node[key]);
      if (err) return cb(err);
      return fn(node, key);
    });
    this._updateCollectionData();
    cb();
    return out;
  }

  _arrayApply(segments, fn, cb) {
    // Lookup a pointer to the property or nested property &
    // return the current value or create a new array
    const arr = this._createImplied(segments, nodeCreateArray);

    if (!Array.isArray(arr)) {
      const message = this._errorMessage(fn.name + ' on non-array', segments, arr);
      const err = new TypeError(message);
      return cb(err);
    }
    const out = fn(arr);
    this._updateCollectionData();
    cb();
    return out;
  }
}

function nodeCreateArray(node, key) {
  var node = node[key] || (node[key] = []);
  return node;
}
