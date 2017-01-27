/**
 * RemoteDoc adapts the ShareJS operation protocol to Racer's mutator
 * interface.
 *
 * 1. It maps Racer's mutator methods to outgoing ShareJS operations.
 * 2. It maps incoming ShareJS operations to Racer events.
 */

import { Doc } from './Doc';
import Model from './Model';
import util from '../util';

export default class RemoteDoc extends Doc {

  private model: Model;
  private shareDoc;

  private debugMutations: boolean;

  constructor(model: Model, collectionName: string, id: string, snapshot, collection) {
    super(model, collectionName, id);

    // This is a bit messy, but we have to immediately register this doc on the
    // collection that added it, so that when we create the shareDoc and the
    // connection emits the 'doc' event, we'll find this doc instead of
    // creating a new one
    if (collection) collection.docs[id] = this;

    this.model = model.pass({$remote: true});
    this.debugMutations = model.root.debug.remoteMutations;

    // Get or create the Share document. Note that we must have already added
    // this doc to the collection to avoid creating a duplicate doc
    this.shareDoc = model.root.connection.get(collectionName, id);
    this.shareDoc.ingestSnapshot(snapshot);
    this._initShareDoc();
  }

  _initShareDoc() {
    const doc = this;
    const model = this.model;
    const collectionName = this.collectionName;
    const id = this.id;
    const shareDoc = this.shareDoc;
    // Override submitOp to disable all writes and perform a dry-run
    if (model.root.debug.disableSubmit) {
      shareDoc.submitOp = () => {};
      shareDoc.create = () => {};
      shareDoc.del = () => {};
    }
    // Subscribe to doc events
    shareDoc.on('op', (op, isLocal) => {
      // Don't emit on local operations, since they are emitted in the mutator
      if (isLocal) return;
      doc._updateCollectionData();
      doc._onOp(op);
    });
    shareDoc.on('del', (previous, isLocal) => {
      // Calling the shareDoc.del method does not emit an operation event,
      // so we create the appropriate event here.
      if (isLocal) return;
      delete doc.collectionData[id];
      model.emit('change', [collectionName, id], [undefined, previous, model._pass]);
    });
    shareDoc.on('create', isLocal => {
      // Local creates should not emit an event, since they only happen
      // implicitly as a result of another mutation, and that operation will
      // emit the appropriate event. Remote creates can set the snapshot data
      // without emitting an operation event, so an event needs to be emitted
      // for them.
      if (isLocal) return;
      doc._updateCollectionData();
      const value = shareDoc.data;
      model.emit('change', [collectionName, id], [value, undefined, model._pass]);
    });
    shareDoc.on('error', err => {
      model._emitError(err, collectionName + '.' + id);
    });
    shareDoc.on('load', () => {
      doc._updateCollectionData();
      const value = shareDoc.data;
      // If we subscribe to an uncreated document, no need to emit 'load' event
      if (value === undefined) return;
      model.emit('load', [collectionName, id], [value, model._pass]);
    });
    this._updateCollectionData();
  }

  _updateCollectionData() {
    const data = this.shareDoc.data;
    if (typeof data === 'object' && !Array.isArray(data) && data !== null) {
      data.id = this.id;
    }
    this.collectionData[this.id] = data;
  }

  create(value, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc create', this.path(), value);
    }
    // We copy the snapshot data at time of create to prevent the id added
    // outside of ShareJS from getting stored in the data
    const data = util.deepCopy(value);
    if (data) delete data.id;
    this.shareDoc.create(data, cb);
    // The id value will get added to the data that was passed in
    this.shareDoc.data = value;
    this._updateCollectionData();
    this.model._context.createDoc(this.collectionName, this.id);
    return;
  }

  set(segments, value, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc set', this.path(segments), value);
    }
    const previous = this._createImplied(segments);
    const lastSegment = segments[segments.length - 1];
    if (previous instanceof ImpliedOp) {
      previous.value[lastSegment] = value;
      this.shareDoc.submitOp(previous.op, cb);
      this._updateCollectionData();
      return;
    }
    const op = (util.isArrayIndex(lastSegment)) ?
      [new ListReplaceOp(segments.slice(0, -1), lastSegment, previous, value)] :
      [new ObjectReplaceOp(segments, previous, value)];
    this.shareDoc.submitOp(op, cb);
    this._updateCollectionData();
    return previous;
  }

  del(segments, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc del', this.path(segments));
    }
    if (segments.length === 0) {
      var previous = this.get();
      this.shareDoc.del(cb);
      delete this.collectionData[this.id];
      return previous;
    }
    // Don't do anything if the value is already undefined, since
    // the del method should not create anything
    var previous = this.get(segments);
    if (previous === undefined) {
      cb();
      return;
    }
    const op = [new ObjectDeleteOp(segments, previous)];
    this.shareDoc.submitOp(op, cb);
    this._updateCollectionData();
    return previous;
  }

  increment(segments: string[], byNumber: number, cb): number {
    if (this.debugMutations) {
      console.log('RemoteDoc increment', this.path(segments), byNumber);
    }
    const previous = this._createImplied(segments);
    if (previous instanceof ImpliedOp) {
      var lastSegment = segments[segments.length - 1];
      previous.value[lastSegment] = byNumber;
      this.shareDoc.submitOp(previous.op, cb);
      this._updateCollectionData();
      return byNumber;
    }
    if (previous == null) {
      var lastSegment = segments[segments.length - 1];
      var op = (util.isArrayIndex(lastSegment)) ?
        [new ListInsertOp(segments.slice(0, -1), lastSegment, byNumber)] :
        [new ObjectInsertOp(segments, byNumber)];
      this.shareDoc.submitOp(op, cb);
      this._updateCollectionData();
      return byNumber;
    }
    var op = [new IncrementOp(segments, byNumber)];
    this.shareDoc.submitOp(op, cb);
    this._updateCollectionData();
    return previous + byNumber;
  }

  push(segments: string[], value, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc push', this.path(segments), value);
    }
    const shareDoc = this.shareDoc;
    function push(arr: any[], fnCb): number {
      const op = [new ListInsertOp(segments, arr.length, value)];
      shareDoc.submitOp(op, fnCb);
      return arr.length;
    }
    return this._arrayApply(segments, push, cb);
  }

  unshift(segments, value, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc unshift', this.path(segments), value);
    }
    const shareDoc = this.shareDoc;
    function unshift(arr, fnCb) {
      const op = [new ListInsertOp(segments, 0, value)];
      shareDoc.submitOp(op, fnCb);
      return arr.length;
    }
    return this._arrayApply(segments, unshift, cb);
  }

  insert(segments, index, values, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc insert', this.path(segments), index, values);
    }
    const shareDoc = this.shareDoc;
    function insert(arr, fnCb) {
      const op = createInsertOp(segments, index, values);
      shareDoc.submitOp(op, fnCb);
      return arr.length;
    }
    return this._arrayApply(segments, insert, cb);
  }

  pop(segments, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc pop', this.path(segments));
    }
    const shareDoc = this.shareDoc;
    function pop(arr, fnCb) {
      const index = arr.length - 1;
      const value = arr[index];
      const op = [new ListRemoveOp(segments, index, value)];
      shareDoc.submitOp(op, fnCb);
      return value;
    }
    return this._arrayApply(segments, pop, cb);
  }

  shift(segments, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc shift', this.path(segments));
    }
    const shareDoc = this.shareDoc;
    function shift(arr, fnCb) {
      const value = arr[0];
      const op = [new ListRemoveOp(segments, 0, value)];
      shareDoc.submitOp(op, fnCb);
      return value;
    }
    return this._arrayApply(segments, shift, cb);
  }

  remove(segments, index, howMany, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc remove', this.path(segments), index, howMany);
    }
    const shareDoc = this.shareDoc;
    function remove(arr, fnCb) {
      const values = arr.slice(index, index + howMany);
      const op = [];
      for (let i = 0, len = values.length; i < len; i++) {
        op.push(new ListRemoveOp(segments, index, values[i]));
      }
      shareDoc.submitOp(op, fnCb);
      return values;
    }
    return this._arrayApply(segments, remove, cb);
  }

  move(segments, from, to, howMany, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc move', this.path(segments), from, to, howMany);
    }
    const shareDoc = this.shareDoc;
    function move(arr, fnCb) {
      // Get the return value
      const values = arr.slice(from, from + howMany);

      // Build an op that moves each item individually
      const op = [];
      for (let i = 0; i < howMany; i++) {
        op.push(new ListMoveOp(segments, (from < to) ? from : from + howMany - 1, (from < to) ? to + howMany - 1 : to));
      }
      shareDoc.submitOp(op, fnCb);

      return values;
    }
    return this._arrayApply(segments, move, cb);
  }

  stringInsert(segments, index, value, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc stringInsert', this.path(segments), index, value);
    }
    const previous = this._createImplied(segments);
    if (previous instanceof ImpliedOp) {
      var lastSegment = segments[segments.length - 1];
      previous.value[lastSegment] = value;
      this.shareDoc.submitOp(previous.op, cb);
      this._updateCollectionData();
      return;
    }
    if (previous == null) {
      var lastSegment = segments[segments.length - 1];
      var op = (util.isArrayIndex(lastSegment)) ?
        [new ListInsertOp(segments.slice(0, -1), lastSegment, value)] :
        [new ObjectInsertOp(segments, value)];
      this.shareDoc.submitOp(op, cb);
      this._updateCollectionData();
      return previous;
    }
    var op = [new StringInsertOp(segments, index, value)];
    this.shareDoc.submitOp(op, cb);
    this._updateCollectionData();
    return previous;
  }

  stringRemove(segments, index, howMany, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc stringRemove', this.path(segments), index, howMany);
    }
    const previous = this._createImplied(segments);
    if (previous instanceof ImpliedOp) return;
    if (previous == null) return previous;
    const removed = previous.slice(index, index + howMany);
    const op = [new StringRemoveOp(segments, index, removed)];
    this.shareDoc.submitOp(op, cb);
    this._updateCollectionData();
    return previous;
  }

  subtypeSubmit(segments: string[], subtype, subtypeOp, cb) {
    if (this.debugMutations) {
      console.log('RemoteDoc subtypeSubmit', this.path(segments), subtype, subtypeOp);
    }
    let previous = this._createImplied(segments);
    if (previous instanceof ImpliedOp) {
      this.shareDoc.submitOp(previous.op);
      previous = undefined;
    }
    const op = new SubtypeOp(segments, subtype, subtypeOp);
    this.shareDoc.submitOp(op, cb);
    this._updateCollectionData();
    return previous;
  }

  get(segments?: string[]) {
    return util.lookup(segments, this.shareDoc.data);
  }

  _createImplied(segments: string[]) {
    if (!this.shareDoc.type) {
      throw new Error('Mutation on uncreated remote document');
    }
    let parent = this.shareDoc;
    let key = 'data';
    let node = parent[key];
    let i = 0;
    let nextKey = segments[i++];
    let op, value;
    while (nextKey != null) {
      if (!node) {
        if (op) {
          value = value[key] = util.isArrayIndex(nextKey) ? [] : {};
        } else {
          value = util.isArrayIndex(nextKey) ? [] : {};
          if (Array.isArray(parent)) {
            if (<any>key >= parent.length) {  // key is a number in a string here, so >= is ok
              op = new ListInsertOp(segments.slice(0, i - 2), key, value);
            } else {
              op = new ListReplaceOp(segments.slice(0, i - 2), key, node, value);
            }
          } else {
            op = new ObjectInsertOp(segments.slice(0, i - 1), value);
          }
        }
        node = value;
      }
      parent = node;
      key = nextKey;
      node = parent[key];
      nextKey = segments[i++];
    }
    if (op) return new ImpliedOp(op, value);
    return node;
  }

  _arrayApply(segments: string[], fn: (arr: any[], cb) => number, cb): number {
    let arr = this._createImplied(segments);
    if (arr instanceof ImpliedOp) {
      this.shareDoc.submitOp(arr.op);
      arr = this.get(segments);
    }
    if (arr == null) {
      const lastSegment = segments[segments.length - 1];
      const op = (util.isArrayIndex(lastSegment)) ?
        [new ListInsertOp(segments.slice(0, -1), lastSegment, [])] :
        [new ObjectInsertOp(segments, [])];
      this.shareDoc.submitOp(op);
      arr = this.get(segments);
    }

    if (!Array.isArray(arr)) {
      const message = this._errorMessage(fn.name + ' on non-array', segments, arr);
      const err = new TypeError(message);
      return cb(err);
    }
    const out = fn(arr, cb);
    this._updateCollectionData();
    return out;
  }

  _onOp(op) {
    let item;
    if (op.length === 1) {
      // ShareDB docs shatter json0 ops into single components during apply
      item = op[0];
    } else if (op.length === 0) {
      // Ignore no-ops
      return;
    } else {
      try {
        op = JSON.stringify(op);
      } catch (err) {}
      throw new Error('Received op with multiple components from ShareDB ' + op);
    }
    let segments = [this.collectionName, this.id].concat(item.p);
    const model = this.model;

    // ObjectReplaceOp, ObjectInsertOp, or ObjectDeleteOp
    if (defined(item.oi) || defined(item.od)) {
      var value = item.oi;
      var previous = item.od;
      model.emit('change', segments, [value, previous, model._pass]);

    // ListReplaceOp
    } else if (defined(item.li) && defined(item.ld)) {
      var value = item.li;
      var previous = item.ld;
      model.emit('change', segments, [value, previous, model._pass]);

    // ListInsertOp
    } else if (defined(item.li)) {
      var index = segments[segments.length - 1];
      const values = [item.li];
      model.emit('insert', segments.slice(0, -1), [index, values, model._pass]);

    // ListRemoveOp
    } else if (defined(item.ld)) {
      var index = segments[segments.length - 1];
      const removed = [item.ld];
      model.emit('remove', segments.slice(0, -1), [index, removed, model._pass]);

    // ListMoveOp
    } else if (defined(item.lm)) {
      const from = segments[segments.length - 1];
      const to = item.lm;
      var howMany = 1;
      model.emit('move', segments.slice(0, -1), [from, to, howMany, model._pass]);

    // StringInsertOp
    } else if (defined(item.si)) {
      var index = segments[segments.length - 1];
      var text = item.si;
      segments = segments.slice(0, -1);
      var value = model._get(segments);
      var previous = value.slice(0, index) + value.slice(index + text.length);
      var pass = model.pass({$stringInsert: {index: index, text: text}})._pass;
      model.emit('change', segments, [value, previous, pass]);

    // StringRemoveOp
    } else if (defined(item.sd)) {
      var index = segments[segments.length - 1];
      var text = item.sd;
      let howMany = text.length;
      segments = segments.slice(0, -1);
      var value = model._get(segments);
      var previous = value.slice(0, index) + text + value.slice(index);
      var pass = model.pass({$stringRemove: {index: index, howMany: howMany}})._pass;
      model.emit('change', segments, [value, previous, pass]);

    // IncrementOp
    } else if (defined(item.na)) {
      var value = this.get(item.p);
      let previous = value - item.na;
      model.emit('change', segments, [value, previous, model._pass]);

    // SubtypeOp
    } else if (defined(item.t)) {
      var value = this.get(item.p);
      // Since this is generic to all subtypes, we don't know how to get a copy
      // of the previous value efficiently. We could make a copy eagerly, but
      // given that embedded types are likely to be used for custom editors,
      // we'll assume they primarily use the returned op and are unlikely to
      // need the previous snapshot data
      var previous = undefined;
      const type = item.t;
      var op = item.o;
      var pass = model.pass({$subtype: {type: type, op: op}})._pass;
      model.emit('change', segments, [value, previous, pass]);
    }
  }
}

function createInsertOp(segments, index, values) {
  if (!Array.isArray(values)) {
    return [new ListInsertOp(segments, index, values)];
  }
  const op = [];
  for (let i = 0, len = values.length; i < len; i++) {
    op.push(new ListInsertOp(segments, index++, values[i]));
  }
  return op;
}


function ImpliedOp(op, value) {
  this.op = op;
  this.value = value;
}


function ObjectReplaceOp(segments: string[], before, after) {
  this.p = util.castSegments(segments);
  this.od = before;
  this.oi = (after === undefined) ? null : after;
}
function ObjectInsertOp(segments: string[], value) {
  this.p = util.castSegments(segments);
  this.oi = (value === undefined) ? null : value;
}
function ObjectDeleteOp(segments: string[], value) {
  this.p = util.castSegments(segments);
  this.od = (value === undefined) ? null : value;
}
function ListReplaceOp(segments: string[], index, before, after) {
  this.p = util.castSegments(segments.concat(index));
  this.ld = before;
  this.li = (after === undefined) ? null : after;
}
function ListInsertOp(segments: string[], index, value) {
  this.p = util.castSegments(segments.concat(index));
  this.li = (value === undefined) ? null : value;
}
function ListRemoveOp(segments: string[], index, value) {
  this.p = util.castSegments(segments.concat(index));
  this.ld = (value === undefined) ? null : value;
}
function ListMoveOp(segments: string[], from, to) {
  this.p = util.castSegments(segments.concat(from));
  this.lm = to;
}
function StringInsertOp(segments: string[], index, value) {
  this.p = util.castSegments(segments.concat(index));
  this.si = value;
}
function StringRemoveOp(segments: string[], index, value) {
  this.p = util.castSegments(segments.concat(index));
  this.sd = value;
}
function IncrementOp(segments: string[], byNumber: number) {
  this.p = util.castSegments(segments);
  this.na = byNumber;
}
function SubtypeOp(segments: string[], subtype, subtypeOp) {
  this.p = util.castSegments(segments);
  this.t = subtype;
  this.o = subtypeOp;
}

function defined(value) {
  return value !== undefined;
}
