import util from '../util';
import Model from './Model';

Model.INITS.push(model => {
  const root = model.root;
  root._refs = new Refs();
  addIndexListeners(root);
  addListener(root, 'change', refChange);
  addListener(root, 'load', refLoad);
  addListener(root, 'unload', refUnload);
  addListener(root, 'insert', refInsert);
  addListener(root, 'remove', refRemove);
  addListener(root, 'move', refMove);
});


/* This adds listeners to the {insert,move,remove}Immediate events.
 *
 * model is the root model.
 */
function addIndexListeners(model) {
  model.on('insertImmediate', function refInsertIndex(segments, eventArgs) {
    const index = eventArgs[0];
    const howMany = eventArgs[1].length;
    function patchInsert(refIndex) {
      return (index <= refIndex) ? refIndex + howMany : refIndex;
    }
    onIndexChange(segments, patchInsert);
  });
  model.on('removeImmediate', function refRemoveIndex(segments, eventArgs) {
    const index = eventArgs[0];
    const howMany = eventArgs[1].length;
    function patchRemove(refIndex) {
      return (index <= refIndex) ? refIndex - howMany : refIndex;
    }
    onIndexChange(segments, patchRemove);
  });
  model.on('moveImmediate', function refMoveIndex(segments, eventArgs) {
    const from = eventArgs[0];
    const to = eventArgs[1];
    const howMany = eventArgs[2];
    function patchMove(refIndex) {
      // If the index was moved itself
      if (from <= refIndex && refIndex < from + howMany) {
        return refIndex + to - from;
      }
      // Remove part of a move
      if (from <= refIndex) refIndex -= howMany;
      // Insert part of a move
      if (to <= refIndex) refIndex += howMany;
      return refIndex;
    }
    onIndexChange(segments, patchMove);
  });
  function onIndexChange(segments, patch) {
    const toPathMap = model._refs.toPathMap;
    const refs = toPathMap.get(segments) || [];
    console.log("onIndexChange - segments: ", segments, "refs: ", refs)

    for(let i = 0, len = refs.length; i < len; i++) {
      const ref = refs[i];
      const from = ref.from;
      if (!(ref.updateIndices &&
        ref.toSegments.length > segments.length)) continue;
      const index = +ref.toSegments[segments.length];
      const patched = patch(index);
      if (index === patched) continue;
      model._refs.remove(from);
      ref.toSegments[segments.length] = '' + patched;
      ref.to = ref.toSegments.join('.');
      model._refs.add(ref);
    }
  }
}

function refChange(model, dereferenced, eventArgs, segments) {
  const value = eventArgs[0];
  // Detect if we are deleting vs. setting to undefined
  if (value === undefined) {
    const parentSegments = segments.slice();
    const last = parentSegments.pop();
    const parent = model._get(parentSegments);
    if (!parent || !(last in parent)) {
      model._del(dereferenced);
      return;
    }
  }
  model._set(dereferenced, value);
}
function refLoad(model, dereferenced, eventArgs) {
  const value = eventArgs[0];
  model._set(dereferenced, value);
}
function refUnload(model, dereferenced) {
  model._del(dereferenced);
}
function refInsert(model, dereferenced, eventArgs) {
  const index = eventArgs[0];
  const values = eventArgs[1];
  model._insert(dereferenced, index, values);
}
function refRemove(model, dereferenced, eventArgs) {
  const index = eventArgs[0];
  const howMany = eventArgs[1].length;
  model._remove(dereferenced, index, howMany);
}
function refMove(model, dereferenced, eventArgs) {
  const from = eventArgs[0];
  const to = eventArgs[1];
  const howMany = eventArgs[2];
  model._move(dereferenced, from, to, howMany);
}

function addListener(model, type, fn) {
  model.on(type + 'Immediate', refListener);
  function refListener(segments, eventArgs) {
    const pass = eventArgs[eventArgs.length - 1];
    // Find cases where an event is emitted on a path where a reference
    // is pointing. All original mutations happen on the fully dereferenced
    // location, so this detection only needs to happen in one direction
    const toPathMap = model._refs.toPathMap;
    let subpath;
    for (let i = 0, len = segments.length; i < len; i++) {
      subpath = (subpath) ? subpath + '.' + segments[i] : segments[i];
      // If a ref is found pointing to a matching subpath, re-emit on the
      // place where the reference is coming from as if the mutation also
      // occured at that path
      var refs = toPathMap.get(subpath.split('.'), true);
      if (!refs.length) continue;
      const remaining = segments.slice(i + 1);
      for (var refIndex = 0, numRefs = refs.length; refIndex < numRefs; refIndex++) {
        var ref = refs[refIndex];
        const dereferenced = ref.fromSegments.concat(remaining);
        // The value may already be up to date via object reference. If so,
        // simply re-emit the event. Otherwise, perform the same mutation on
        // the ref's path
        if (model._get(dereferenced) === model._get(segments)) {
          model.emit(type, dereferenced, eventArgs);
        } else {
          var setterModel = ref.model.pass(pass, true);
          setterModel._dereference = noopDereference;
          fn(setterModel, dereferenced, eventArgs, segments);
        }
      }
    }
    // If a ref points to a child of a matching subpath, get the value in
    // case it has changed and set if different
    const parentToPathMap = model._refs.parentToPathMap;
    var refs = parentToPathMap.get(subpath.split('.'), true);
    if (!refs.length) return;
    for (var refIndex = 0, numRefs = refs.length; refIndex < numRefs; refIndex++) {
      var ref = refs[refIndex];
      const value = model._get(ref.toSegments);
      const previous = model._get(ref.fromSegments);
      if (previous !== value) {
        var setterModel = ref.model.pass(pass, true);
        setterModel._dereference = noopDereference;
        setterModel._set(ref.fromSegments, value);
      }
    }
  }
}

Model.prototype._canRefTo = function(value) {
  return this.isPath(value) || (value && typeof value.ref === 'function');
};

Model.prototype.ref = function() {
  let from, to, options;
  if (arguments.length === 1) {
    to = arguments[0];
  } else if (arguments.length === 2) {
    if (this._canRefTo(arguments[1])) {
      from = arguments[0];
      to = arguments[1];
    } else {
      to = arguments[0];
      options = arguments[1];
    }
  } else {
    from = arguments[0];
    to = arguments[1];
    options = arguments[2];
  }
  const fromPath = this.path(from);
  const toPath = this.path(to);
  // Make ref to reffable object, such as query or filter
  if (!toPath) return to.ref(fromPath);
  const ref = new Ref(this.root, fromPath, toPath, options);
  if (ref.fromSegments.length < 2) {
    throw new Error('ref must be performed under a collection ' +
      'and document id. Invalid path: ' + fromPath);
  }
  this.root._refs.remove(fromPath);
  this.root._refLists.remove(fromPath);
  const value = this.get(to);
  ref.model._set(ref.fromSegments, value);
  this.root._refs.add(ref);
  return this.scope(fromPath);
};

Model.prototype.removeRef = function(subpath) {
  const segments = this._splitPath(subpath);
  const fromPath = segments.join('.');
  this._removeRef(segments, fromPath);
};
Model.prototype._removeRef = function(segments, fromPath) {
  this.root._refs.remove(fromPath);
  this.root._refLists.remove(fromPath);
  this._del(segments);
};

Model.prototype.removeAllRefs = function(subpath) {
  const segments = this._splitPath(subpath);
  this._removeAllRefs(segments);
};
Model.prototype._removeAllRefs = function(segments) {
  this._removePathMapRefs(segments, this.root._refs.fromPathMap);
  this._removeMapRefs(segments, this.root._refLists.fromMap);
};
Model.prototype._removePathMapRefs = function(segments, map) {
  const refs = map.getList(segments);
  for(let i = 0, len = refs.length; i < len; i++) {
    const ref = refs[i];
    this._removeRef(ref.fromSegments, ref.from);
  }
};
Model.prototype._removeMapRefs = function(segments, map) {
  for (const from in map) {
    const fromSegments = map[from].fromSegments;
    if (util.contains(segments, fromSegments)) {
      this._removeRef(fromSegments, from);
    }
  }
};

Model.prototype.dereference = function(subpath) {
  const segments = this._splitPath(subpath);
  return this._dereference(segments).join('.');
};

Model.prototype._dereference = function(segments, forArrayMutator, ignore) {
  if (segments.length === 0) return segments;
  const refs = this.root._refs.fromPathMap;
  const refLists = this.root._refLists.fromMap;
  let doAgain;
  do {
    let subpath = '';
    doAgain = false;
    for (let i = 0, len = segments.length; i < len; i++) {
      subpath = (subpath) ? subpath + '.' + segments[i] : segments[i];

      const ref = refs.get(subpath.split('.'));
      if (ref) {
        const remaining = segments.slice(i + 1);
        segments = ref.toSegments.concat(remaining);
        doAgain = true;
        break;
      }

      const refList = refLists[subpath];
      if (refList && refList !== ignore) {
        const belowDescendant = i + 2 < len;
        const belowChild = i + 1 < len;
        if (!(belowDescendant || forArrayMutator && belowChild)) continue;
        segments = refList.dereference(segments, i);
        doAgain = true;
        break;
      }
    }
  } while (doAgain);
  // If a dereference fails, return a path that will result in a null value
  // instead of a path to everything in the model
  if (segments.length === 0) return ['$null'];
  return segments;
};

function noopDereference(segments) {
  return segments;
}

class Ref {
  constructor(model, from, to, options) {
    this.model = model && model.pass({$ref: this});
    this.from = from;
    this.to = to;
    this.fromSegments = from.split('.');
    this.toSegments = to.split('.');
    this.parentTos = [];
    for (let i = 1, len = this.toSegments.length; i < len; i++) {
      const parentTo = this.toSegments.slice(0, i).join('.');
      this.parentTos.push(parentTo);
    }
    this.updateIndices = options && options.updateIndices;
  }
}

class Refs {
  constructor() {
    this.parentToPathMap = new PathListMap();
    this.toPathMap = new PathListMap();
    this.fromPathMap = new PathMap();
  }

  add(ref) {
    this.fromPathMap.add(ref.fromSegments, ref);
    this.toPathMap.add(ref.toSegments, ref);
    for (let i = 0, len = ref.parentTos.length; i < len; i++) {
      this.parentToPathMap.add(ref.parentTos[i].split('.'), ref);
    }
  }

  remove(from) {
    const ref = this.fromPathMap.get((from || '').split('.'));
    if (!ref) return;
    this.fromPathMap.delete(ref.fromSegments);
    this.toPathMap.delete(ref.toSegments, ref);
    for (let i = 0, len = ref.parentTos.length; i < len; i++) {
      this.parentToPathMap.delete(ref.parentTos[i].split('.'), ref);
    }
    return ref;
  }

  toJSON() {
    const out = [];
    const refs = this.fromPathMap.getList([]);

    for(let i = 0, len = refs.length; i < len; i++) {
      const ref = refs[i];
      out.push([ref.from, ref.to]);
    }
    return out;
  }
}

class PathMap {
  constructor() {
    this.map = {};
  }

  add(segments, item) {
    let map = this.map;

    for(let i = 0, len = segments.length - 1; i < len; i++) {
      map[segments[i]] = map[segments[i]] || {};
      map = map[segments[i]];
    }

    map[segments[segments.length - 1]] = {"$item": item};
  }

  get(segments) {
    const val = this._get(segments);

    return (val && val['$item']) ? val['$item'] : void 0;
  }

  _get(segments) {
    let val = this.map;

    for(let i = 0, len = segments.length; i < len; i++) {
      val = val[segments[i]];
      if(!val) return;
    }

    return val;
  }

  getList(segments) {
    const obj = this._get(segments);

    return flattenObj(obj);
  }

  delete(segments) {
    del(this.map, segments.slice(0), true);
  }
}

function flattenObj(obj) {
  if(!obj) return [];

  let arr = [];
  const keys = Object.keys(obj);
  if(obj['$item']) arr.push(obj['$item']);

  for(let i = 0, len = keys.length; i < len; i++) {
    if(keys[i] === '$item') continue;

    arr = arr.concat(flattenObj(obj[keys[i]]));
  }

  return arr;
}

function del(map, segments, safe) {
  const segment = segments.shift();

  if(!segments.length) {
    if(safe) {
      delete map[segment];
      return false;
    } else {
      return true;
    }
  }

  const nextMap = map[segment];
  if(!nextMap) return true;

  const nextSafe = (Object.keys(nextMap).length > 1);
  const remove = del(nextMap, segments, nextSafe);

  if(remove) {
    if(safe) {
      delete map[segment];
      return false;
    } else {
      return true;
    }
  }
}

class PathListMap {
  constructor() {
    this.map = {};
  }

  add(segments, item) {
    let map = this.map;

    for(let i = 0, len = segments.length - 1; i < len; i++) {
      map[segments[i]] = map[segments[i]] || {"$items": []};
      map = map[segments[i]];
    }

    const segment = segments[segments.length - 1];

    map[segment] = map[segment] || {"$items": []};
    map[segment]['$items'].push(item);
  }

  get(segments, onlyAtLevel) {
    let val = this.map;

    for(let i = 0, len = segments.length; i < len; i++) {
      val = val[segments[i]];
      if(!val) return [];
    }

    if(onlyAtLevel) return (val['$items'] || []);

    return flatten(val);
  }

  delete(segments, item) {
    delList(this.map, segments.slice(0), item, true);
  }
}

function flatten(obj) {
  const arr = obj['$items'] || [];
	console.log("****** FLATTEN ******")
  const keys = Object.keys(obj);

  for(let i = 0, len = keys.length; i < len; i++) {
    if(keys[i] === '$items') continue;

    arr.concat(flatten(obj[keys[i]]));
  }

  return arr;
}

function delList(map, segments, item, safe) {
  const segment = segments.shift();

  if(!segments.length) {
    if(!map[segment] || !map[segment]['$items']) return true;

    const items = map[segment]['$items'];
    const keys = Object.keys(map[segment]);

    if(items.length < 2 && keys.length < 2) {
      if(safe) {
        delete map[segment];
        return false;
      } else {
        return true;
      }
    } else {
      const i = items.indexOf(item);

      if(i > -1) items.splice(i, 1);

      return false;
    }
  }

  const nextMap = map[segment];
  if(!nextMap) return true;

  const nextSafe = (Object.keys(nextMap).length > 2 || nextMap['$items'].length);
  const remove = delList(nextMap, segments, item, nextSafe);

  if(remove) {
    if(safe) {
      delete map[segment];
      return false;
    } else {
      return true;
    }
  }
}
