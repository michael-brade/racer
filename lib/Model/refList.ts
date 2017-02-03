import * as util from '../util';
import Model from './Model';


function patchFromEvent(type: string, segments: string[], eventArgs: any[], refList: RefList): void {
  const fromLength = refList.fromSegments.length;
  const segmentsLength = segments.length;
  const pass = eventArgs[eventArgs.length - 1];
  const model = refList.model.pass(pass, true);

  // Mutation on the `from` output itself
  if (segmentsLength === fromLength) {
    if (type === 'insert') {
      let index = eventArgs[0];
      let values = eventArgs[1];
      let ids = setNewToValues(model, refList, values);
      model._insert(refList.idsSegments, index, ids);
      return;
    }

    if (type === 'remove') {
      let index = eventArgs[0];
      let howMany = eventArgs[1].length;
      let ids = model._remove(refList.idsSegments, index, howMany);
      // Delete the appropriate items underneath `to` if the `deleteRemoved`
      // option was set true
      if (refList.deleteRemoved) {
        for (let i = 0; i < ids.length; i++) {
          const item = refList.itemById(ids[i]);
          model._del(refList.toSegmentsByItem(item));
        }
      }
      return;
    }

    if (type === 'move') {
      const from = eventArgs[0];
      const to = eventArgs[1];
      let howMany = eventArgs[2];
      model._move(refList.idsSegments, from, to, howMany);
      return;
    }

    // Change of the entire output
    let values = (type === 'change') ?
      eventArgs[0] : model._get(refList.fromSegments);
    // Set ids to empty list if output is set to null
    if (!values) {
      model._set(refList.idsSegments, []);
      return;
    }
    // If the entire output is set, create a list of ids based on the output,
    // and update the corresponding items
    var ids = setNewToValues(model, refList, values);
    model._set(refList.idsSegments, ids);
    return;
  }

  // If mutation is on a parent of `from`, we might need to re-create the
  // entire refList output
  if (segmentsLength < fromLength) {
    model._setArrayDiff(refList.fromSegments, refList.get());
    return;
  }

  var index = segments[fromLength];
  const value = model._get(refList.fromSegments.concat(index));
  const toSegments = refList.toSegmentsByItem(value);

  // Mutation underneath a child of the `from` object.
  if (segmentsLength > fromLength + 1) {
    throw new Error('Mutation on descendant of refList `from`' +
      ' should have been dereferenced: ' + segments.join('.'));
  }

  // Otherwise, mutation of a child of the `from` object

  // If changing the item itself, it will also have to be re-set on the
  // original object
  if (type === 'change') {
    model._set(toSegments, value);
    updateIdForValue(model, refList, index, value);
    return;
  }
  if (type === 'insert' || type === 'remove' || type === 'move') {
    throw new Error('Array mutation on child of refList `from`' +
      'should have been dereferenced: ' + segments.join('.'));
  }
}

function setNewToValues(model: Model, refList: RefList, values: any[]): any[] {
  const ids = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    let id = refList.idByItem(value);
    if (id === undefined && typeof value === 'object') {
      id = value.id = model.id();
    }
    const toSegments = refList.toSegmentsByItem(value);
    if (id === undefined || toSegments === undefined) {
      throw new Error('Unable to add item to refList: ' + value);
    }
    if (model._get(toSegments) !== value) {
      model._set(toSegments, value);
    }
    ids.push(id);
  }
  return ids;
}
function updateIdForValue(model: Model, refList: RefList, index, value): void {
  const id = refList.idByItem(value);
  const outSegments = refList.idsSegments.concat(index);
  model._set(outSegments, id);
}

function patchToEvent(type: string, segments: string[], eventArgs: any[], refList: RefList): void {
  const toLength = refList.toSegments.length;
  const segmentsLength = segments.length;
  const pass = eventArgs[eventArgs.length - 1];
  const model = refList.model.pass(pass, true);

  // Mutation on the `to` object itself
  if (segmentsLength === toLength) {
    if (type === 'insert') {
      var values = eventArgs[1];
      for (var i = 0; i < values.length; i++) {
        var value = values[i];
        var indices = refList.indicesByItem(value);
        if (!indices) continue;
        for (var j = 0; j < indices.length; j++) {
          var outSegments = refList.fromSegments.concat(indices[j].toString());
          model._set(outSegments, value);
        }
      }
      return;
    }

    if (type === 'remove') {
      const removeIndex = eventArgs[0];
      var values = eventArgs[1];
      const howMany = values.length;
      for (let i = removeIndex, len = removeIndex + howMany; i < len; i++) {
        var indices = refList.indicesByItem(values[i]);
        if (!indices) continue;
        for (let j = 0, indicesLen = indices.length; j < indicesLen; j++) {
          var outSegments = refList.fromSegments.concat(indices[j].toString());
          model._set(outSegments, undefined);
        }
      }
      return;
    }

    if (type === 'move') {
      // Moving items in the `to` object should have no effect on the output
      return;
    }
  }

  // Mutation on or above the `to` object
  if (segmentsLength <= toLength) {
    // If the entire `to` object is updated, we need to re-create the
    // entire refList output and apply what is different
    model._setArrayDiff(refList.fromSegments, refList.get());
    return;
  }

  // Mutation underneath a child of the `to` object. The item will already
  // be up to date, since it is under an object reference. Just re-emit
  if (segmentsLength > toLength + 1) {
    var value = model._get(segments.slice(0, toLength + 1));
    var indices = refList.indicesByItem(value);
    if (!indices) return;
    const remaining = segments.slice(toLength + 1);
    for (var i = 0; i < indices.length; i++) {
      const index = indices[i];
      var dereferenced = refList.fromSegments.concat(index.toString(), remaining);
      dereferenced = model._dereference(dereferenced, null, refList);
      eventArgs = eventArgs.slice();
      eventArgs[eventArgs.length - 1] = model._pass;
      model.emit(type, dereferenced, eventArgs);
    }
    return;
  }

  // Otherwise, mutation of a child of the `to` object

  // If changing the item itself, it will also have to be re-set on the
  // array created by the refList
  if (type === 'change' || type === 'load' || type === 'unload') {
    let value;
    let previous;
    if (type === 'change') {
      value = eventArgs[0];
      previous = eventArgs[1];
    } else if (type === 'load') {
      value = eventArgs[0];
      previous = undefined;
    } else if (type === 'unload') {
      value = undefined;
      previous = eventArgs[0];
    }
    const newIndices = refList.indicesByItem(value);
    const oldIndices = refList.indicesByItem(previous);
    if (!newIndices && !oldIndices) return;
    if (oldIndices && !equivalentArrays(oldIndices, newIndices)) {
      // The changed item used to refer to some indices, but no longer does
      for (var i = 0; i < oldIndices.length; i++) {
        var outSegments = refList.fromSegments.concat(oldIndices[i].toString());
        model._set(outSegments, undefined);
      }
    }
    if (newIndices) {
      for (var i = 0; i < newIndices.length; i++) {
        var outSegments = refList.fromSegments.concat(newIndices[i].toString());
        model._set(outSegments, value);
      }
    }
    return;
  }

  var value = model._get(segments.slice(0, toLength + 1));
  var indices = refList.indicesByItem(value);
  if (!indices) return;

  if (type === 'insert' || type === 'remove' || type === 'move') {
    // Array mutations will have already been updated via an object
    // reference, so only re-emit
    for (var i = 0; i < indices.length; i++) {
      var dereferenced = refList.fromSegments.concat(indices[i].toString());
      dereferenced = model._dereference(dereferenced, null, refList);
      eventArgs = eventArgs.slice();
      eventArgs[eventArgs.length - 1] = model._pass;
      model.emit(type, dereferenced, eventArgs);
    }
  }
}
function equivalentArrays(a, b): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function patchIdsEvent(type: string, segments: string[], eventArgs: any[], refList: RefList): void {
  const idsLength = refList.idsSegments.length;
  const segmentsLength = segments.length;
  const pass = eventArgs[eventArgs.length - 1];
  const model = refList.model.pass(pass, true);

  var index;

  // An array mutation of the ids should be mirrored with a like change in
  // the output array
  if (segmentsLength === idsLength) {
    if (type === 'insert') {
      index = eventArgs[0];
      const inserted = eventArgs[1];
      const values = [];
      for (let i = 0; i < inserted.length; i++) {
        const value = refList.itemById(inserted[i]);
        values.push(value);
      }
      model._insert(refList.fromSegments, index, values);
      return;
    }

    if (type === 'remove') {
      index = eventArgs[0];
      var howMany = eventArgs[1].length;
      model._remove(refList.fromSegments, index, howMany);
      return;
    }

    if (type === 'move') {
      const from = eventArgs[0];
      const to = eventArgs[1];
      var howMany = eventArgs[2];
      model._move(refList.fromSegments, from, to, howMany);
      return;
    }
  }

  // Mutation on the `ids` list itself
  if (segmentsLength <= idsLength) {
    // If the entire `ids` array is updated, we need to re-create the
    // entire refList output and apply what is different
    model._setArrayDiff(refList.fromSegments, refList.get());
    return;
  }

  // Otherwise, direct mutation of a child in the `ids` object or mutation
  // underneath an item in the `ids` list. Update the item for the appropriate
  // id if it has changed
  index = segments[idsLength];
  const id = refList.idByIndex(index);
  const item = refList.itemById(id);
  const itemSegments = refList.fromSegments.concat(index);
  if (model._get(itemSegments) !== item) {
    model._set(itemSegments, item);
  }
}

Model.prototype.refList = function() {
  let from, to, ids, options;
  if (arguments.length === 2) {
    to = arguments[0];
    ids = arguments[1];
  } else if (arguments.length === 3) {
    if (this.isPath(arguments[2])) {
      from = arguments[0];
      to = arguments[1];
      ids = arguments[2];
    } else {
      to = arguments[0];
      ids = arguments[1];
      options = arguments[2];
    }
  } else {
    from = arguments[0];
    to = arguments[1];
    ids = arguments[2];
    options = arguments[3];
  }
  const fromPath = this.path(from);
  let toPath;
  if (Array.isArray(to)) {
    toPath = [];
    for (let i = 0; i < to.length; i++) {
      toPath.push(this.path(to[i]));
    }
  } else {
    toPath = this.path(to);
  }
  const idsPath = this.path(ids);
  const refList = new RefList(this.root, fromPath, toPath, idsPath, options);
  this.root._refLists.remove(fromPath);
  refList.model._setArrayDiff(refList.fromSegments, refList.get());
  this.root._refLists.add(refList);
  return this.scope(fromPath);
};

export class RefList {
  public model: Model;

  public from: string;
  public to: string;
  public ids: string;

  public fromSegments: string[];
  public toSegments: string[];
  public idsSegments: string[];

  public options: {
    deleteRemoved: boolean
  };

  public deleteRemoved: boolean;


  constructor(model: Model, from: string, to: string, ids: string, options?: { deleteRemoved: boolean }) {
    this.model = model && model.pass({$refList: this});
    this.from = from;
    this.to = to;
    this.ids = ids;
    this.fromSegments = from && from.split('.');
    this.toSegments = to && to.split('.');
    this.idsSegments = ids && ids.split('.');
    this.options = options;
    this.deleteRemoved = options && options.deleteRemoved;
  }

  // The default implementation assumes that the ids array is a flat list of
  // keys on the to object. Ideally, this mapping could be customized via
  // inheriting from RefList and overriding these methods without having to
  // modify the above event handling code.
  //
  // In the default refList implementation, `key` and `id` are equal.
  //
  // Terms in the below methods:
  //   `item`  - Object on the `to` path, which gets mirrored on the `from` path
  //   `key`   - The property under `to` at which an item is located
  //   `id`    - String or object in the array at the `ids` path
  //   `index` - The index of an id, which corresponds to an index on `from`
  get(): any[] {
    const ids: any[] = this.model._get(this.idsSegments);
    if (!ids) return [];
    const items = this.model._get(this.toSegments);
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const key = ids[i];
      out.push(items && items[key]);
    }
    return out;
  }

  dereference(segments: string[], i: number): string[] {
    const remaining = segments.slice(i + 1);
    const key = this.idByIndex(remaining[0]);
    if (key == null) return [];
    remaining[0] = key;
    return this.toSegments.concat(remaining);
  }

  toSegmentsByItem(item): string[] {
    const key = this.idByItem(item);
    if (key === undefined) return;
    return this.toSegments.concat(key);
  }

  idByItem(item) {
    if (item && item.id) return item.id;
    const items = this.model._get(this.toSegments);
    for (const key in items) {
      if (item === items[key]) return key;
    }
  }

  indicesByItem(item): number[] {
    const id = this.idByItem(item);
    const ids = this.model._get(this.idsSegments);
    if (!ids) return;
    let indices: number[];
    let index = -1;
    for (; ; ) {
      index = ids.indexOf(id, index + 1);
      if (index === -1) break;
      if (indices) {
        indices.push(index);
      } else {
        indices = [index];
      }
    }
    return indices;
  }

  itemById(id) {
    return this.model._get(this.toSegments.concat(id));
  }

  idByIndex(index) {
    return this.model._get(this.idsSegments.concat(index));
  }

  onMutation(type: string, segments: string[], eventArgs: any[]): void {
    if (util.mayImpact(this.toSegments, segments)) {
      patchToEvent(type, segments, eventArgs, this);
    } else if (util.mayImpact(this.idsSegments, segments)) {
      patchIdsEvent(type, segments, eventArgs, this);
    } else if (util.mayImpact(this.fromSegments, segments)) {
      patchFromEvent(type, segments, eventArgs, this);
    }
  }
}

export class FromMap {
  [from: string]: RefList
}

export class RefLists {
  public fromMap: FromMap;

  constructor() {
    this.fromMap = new FromMap();
  }

  add(refList: RefList): void {
    this.fromMap[refList.from] = refList;
  }

  remove(from: string): RefList {
    const refList = this.fromMap[from];
    delete this.fromMap[from];
    return refList;
  }

  toJSON(): any[] {
    const out = [];
    for (const from in this.fromMap) {
      const refList = this.fromMap[from];
      out.push([refList.from, refList.to, refList.ids, refList.options]);
    }
    return out;
  }
}
