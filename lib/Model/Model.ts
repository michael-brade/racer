import { Collection, CollectionMap, ModelData } from './collections';
import { Doc } from './Doc';
import { Filter, Filters } from './filter';
import { Fns, NamedFns } from './fn';
import Query from './Query';
import { Refs } from './ref';
import { RefLists } from './refList';


export default Model;

export interface ChildModel extends Model {}


export interface Options {
  debug?: DebugOptions;
  bundleTimeout?: number;

  // subscriptions
  fetchOnly?: boolean;
  unloadDelay?: number;
}
export interface DebugOptions {
  remoteMutations?: boolean;
  disableSubmit?: boolean;
}


export interface Model {
  root: Model;
  debug: DebugOptions;

  // bundle  SERVER!!
  // bundleTimeout: number;
  // _commit: Function;

  // collections
  collections: CollectionMap;
  data: ModelData;

  // events
  _mutatorEventQueue: [string, string[], any[]][];
  _pass: any; // TODO typeof Passed;
  _silent: boolean;
  _eventContext: any;
  _defaultCallback: (err?) => void;
  _events: any;
  _maxListeners: any;

  // filter
  _filters: Filters;

  // fn
  _namedFns: NamedFns;
  _fns: Fns;

  // paths
  _at: string;

  // ref
  _refs: Refs;

  // refList
  _refLists: RefLists;
}

export interface Model {
  id(): string;
  _child(): ChildModel;


  /** //////////////////////
  // events
  //////////////////////*/

  wrapCallback(cb: any): (err?: any) => void;
  _emitError(err: any, context?: any): void;
  emit(type: string, ...args: any[]): any;
  addListener(type: string | symbol, listener: Function): this;
  on(type: string | symbol, listener: Function): this;
  once(type: string | symbol, listener: Function): this;
  removeAllListeners(type?: string | symbol, subpattern?: string): this;
  pass(object: Object, invert?: boolean): ChildModel;
  /**
   * The returned Model will or won't trigger event handlers when the model emits
   * events, depending on `value`
   * @param {Boolean|Null} value defaults to true
   * @return {Model}
   */
  silent(value?: boolean | null): ChildModel;
  eventContext(value: any): ChildModel;
  removeContextListeners(value: any): Model;


  /** //////////////////////
  // paths
  //////////////////////*/

  _splitPath(subpath?: string | number): string[];
  /**
   * Returns the path equivalent to the path of the current scoped model plus
   * (optionally) a suffix subpath
   *
   * @optional @param {String} subpath
   * @return {String} absolute path
   * @api public
   */
  path(subpath?: string | number | {
      path: () => string;
  }): string;
  isPath(subpath: string | number | {
      path: () => string;
  }): boolean;
  scope(path: string): ChildModel;
  /**
   * Create a model object scoped to a particular path.
   * Example:
   *     var user = model.at('users.1');
   *     user.set('username', 'brian');
   *     user.on('push', 'todos', function(todo) {
   *       // ...
   *     });
   *
   *  @param {String} segment
   *  @return {Model} a scoped model
   *  @api public
   */
  at(subpath: string | number | {
      path: () => string;
  }): ChildModel;
  /**
   * Returns a model scope that is a number of levels above the current scoped
   * path. Number of levels defaults to 1, so this method called without
   * arguments returns the model scope's parent model scope.
   *
   * @optional @param {Number} levels
   * @return {Model} a scoped model
   */
  parent(levels: number): ChildModel;
  /**
   * Returns the last property segment of the current model scope path
   *
   * @optional @param {String} path
   * @return {String}
   */
  leaf(path: string): string;


  /** //////////////////////
  // collections
  //////////////////////*/

  getCollection(collectionName: string): Collection;
  getDoc(collectionName: string, id: any): Doc;
  get(subpath: string): any;
  _get(segments: string[]): any;
  getCopy(subpath: string): any;
  _getCopy(segments: string[]): any;
  getDeepCopy(subpath: string): any;
  _getDeepCopy(segments: string[]): any;
  getOrCreateCollection(name: string): Collection;
  _getDocConstructor(name?: string): {
      new (model: Model, collectionName: string, id: string, data, collection): Doc;
  };
  /**
   * Returns an existing document with id in a collection. If the document does
   * not exist, then creates the document with id in a collection and returns the
   * new document.
   * @param {String} collectionName
   * @param {String} id
   * @param {Object} [data] data to create if doc with id does not exist in collection
   */
  getOrCreateDoc(collectionName: string, id: string, data?: any): Doc;
  destroy(subpath: string): void;


  /** //////////////////////
  // mutators
  //////////////////////*/

  _mutate(segments: string[], fn: any, cb: any): any;
  set(): any;
  _set(segments: string[], value: any, cb?: Function): any;
  setNull(): any;
  _setNull(segments: string[], value: any, cb: any): any;
  setEach(): void;
  _setEach(segments: string[], object: any, cb: any): void;
  create(): any;
  _create(segments: string[], value: any, cb: any): any;
  createNull(): void;
  _createNull(segments: string[], value: any, cb: any): void;
  add(): any;
  _add(segments: string[], value: any, cb: any): any;
  del(): any;
  _del(segments: string[], cb?: any): any;
  increment(): any;
  _increment(segments: string[], byNumber: number, cb: any): any;
  push(): any;
  _push(segments: string[], value: any, cb: any): any;
  unshift(): any;
  _unshift(segments: string[], value: any, cb: any): any;
  insert(): any;
  _insert(segments: string[], index: number, values: any, cb?: any): any;
  pop(): any;
  _pop(segments: string[], cb: any): any;
  shift(): any;
  _shift(segments: string[], cb: any): any;
  remove(): any;
  _remove(segments: string[], index: number, howMany: number, cb?: any): any;
  move(): any;
  _move(segments: string[], from: number, to: number, howMany: number, cb?: Function): any;
  stringInsert(): any;
  _stringInsert(segments: string[], index: any, text: any, cb: any): any;
  stringRemove(): any;
  _stringRemove(segments: string[], index: any, howMany: any, cb: any): any;
  subtypeSubmit(): any;
  _subtypeSubmit(segments: string[], subtype: any, subtypeOp: any, cb: any): any;


  /** //////////////////////
  // setDiff
  //////////////////////*/

  setDiff(): any;
  _setDiff(segments: any, value: any, cb?: any): any;
  setDiffDeep(): void;
  _setDiffDeep(segments: any, value: any, cb?: any): void;
  setArrayDiff(): void;
  setArrayDiffDeep(): void;
  _setArrayDiffDeep(segments: string[], value: any, cb?: any): void;
  _setArrayDiff(segments: string[], value: any, cb?: any, _equalFn?: any): void;
  _applyArrayDiff(segments: any, diff: any, cb?: any): any;


  /** //////////////////////
  // fn
  //////////////////////*/

  fn(name: string, fns: any): void;
  evaluate(): any;
  start(): any;
  stop(subpath: string | number): void;
  _stop(fromPath: any): void;
  stopAll(subpath: string | number): void;
  _stopAll(segments: string[]): void;


  /** //////////////////////
  // filter
  //////////////////////*/

  filter(path: string, fn: Function): Filter;
  filter(path: string, options: Object, fn: Function): Filter;
  filter(path: string, inputPath1: string, fn: Function): Filter;
  filter(path: string, inputPath1: string, options: Object, fn: Function): Filter;
  filter(path: string, inputPath1: string, inputPath2: string, fn: Function): Filter;
  filter(path: string, inputPath1: string, inputPath2: string, options: Object, fn: Function): Filter;
  sort(path: string, fn: Function): Filter;
  sort(path: string, options: Object, fn: Function): Filter;
  sort(path: string, inputPath1: string, fn: Function): Filter;
  sort(path: string, inputPath1: string, options: Object, fn: Function): Filter;
  sort(path: string, inputPath1: string, inputPath2: string, fn: Function): Filter;
  sort(path: string, inputPath1: string, inputPath2: string, options: Object, fn: Function): Filter;
  removeAllFilters(subpath?: string): void;
  _removeAllFilters(segments: string[]): void;


  /** //////////////////////
  // ref
  //////////////////////*/

  _canRefTo(value: any): boolean;
  ref(to: string, options?: {
      updateIndices: boolean;
  }): ChildModel;
  ref(from: string, to: string | Query | Filter, options?: {
      updateIndices: boolean;
  }): ChildModel;
  removeRef(subpath: string | number): void;
  _removeRef(segments: string[], fromPath: string): void;
  removeAllRefs(subpath: string | number): void;
  _removeAllRefs(segments: string[]): void;
  _removePathMapRefs(segments: string[], map: any): void;
  _removeMapRefs(segments: string[], map: any): void;
  dereference(subpath: any): string;
  _dereference(segments: string[], forArrayMutator?: any, ignore?: any): string[];


  /** //////////////////////
  // refList
  //////////////////////*/

  refList(from: string, to: string, ids: string, options?: {
      deleteRemoved: boolean;
  }): ChildModel;
  refList(to: string, ids: string, options?: {
      deleteRemoved: boolean;
  }): ChildModel;
}
