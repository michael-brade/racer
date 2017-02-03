import * as util from '../util';
import Model from './Model';
import defaultFns from './defaultFns';

export class NamedFns {}

export class FromMap {
  [name: string]: Fn;
}

export class Fns {
  private model: Model;
  private nameMap: NamedFns;
  public fromMap: FromMap;

  constructor(model: Model) {
    this.model = model;
    this.nameMap = model.root._namedFns;
    this.fromMap = new FromMap();
  }

  get(name: string, inputPaths: string[], fns, options: FnOptions) {
    fns || (fns = this.nameMap[name] || defaultFns[name]);
    const fn = new Fn(this.model, name, null, inputPaths, fns, options);
    return fn.get();
  }

  start(name: string, path: string, inputPaths: string[], fns, options: FnOptions) {
    fns || (fns = this.nameMap[name] || defaultFns[name]);
    const fn = new Fn(this.model, name, path, inputPaths, fns, options);
    this.fromMap[path] = fn;
    return fn.onInput();
  }

  stop(path: string): Fn {
    const fn = this.fromMap[path];
    delete this.fromMap[path];
    return fn;
  }

  toJSON() {
    const out = [];
    for (const from in this.fromMap) {
      const fn = this.fromMap[from];
      // Don't try to bundle non-named functions that were started via
      // model.start directly instead of by name
      if (!fn.name) continue;
      const args: any = [fn.from].concat(fn.inputPaths);
      if (fn.options) args.push(fn.options);
      args.push(fn.name);
      out.push(args);
    }
    return out;
  }
}

export type ModeOptions = 'diffDeep' | 'diff' | 'arrayDeep' | 'array';
export type CopyOptions = 'output' | 'input' | 'both' | 'none';

export interface FnOptions {
  copy?: CopyOptions;
  mode?: ModeOptions;
}

interface FnGet {
}
export interface FnGetSet {
  get: Function;
  set: Function;
}

function isTwoWay(fns): fns is FnGetSet {
  if (fns.get)
    return true;

  return false;
}

export class Fn {
  private model: Model;
  public name: string;
  public from: string;
  private getFn: Function;
  private setFn: Function;
  public inputPaths: string[];
  public fromSegments: string[];
  public inputsSegments: string[][];

  private copyInput: boolean;
  private copyOutput: boolean;

  private mode: ModeOptions;
  public options: FnOptions;

  constructor(
    model: Model,
    name: string,
    from: string,
    inputPaths: string[],
    fns: Function | FnGetSet,
    options: FnOptions
  ) {
    this.model = model.pass({$fn: this});
    this.name = name;
    this.from = from;
    this.inputPaths = inputPaths;
    this.options = options;
    if (!fns) {
      throw new TypeError('Model function not found: ' + name);
    }
    this.getFn = isTwoWay(fns) ? fns.get : fns;
    this.setFn = isTwoWay(fns) ? fns.set : undefined;
    this.fromSegments = from && from.split('.');
    this.inputsSegments = [];
    for (let i = 0; i < this.inputPaths.length; i++) {
      const segments = this.inputPaths[i].split('.');
      this.inputsSegments.push(segments);
    }

    // Copy can be 'output', 'input', 'both', or 'none'
    const copy = (options && options.copy) || 'output';
    this.copyInput = (copy === 'input' || copy === 'both');
    this.copyOutput = (copy === 'output' || copy === 'both');

    // Mode can be 'diffDeep', 'diff', 'arrayDeep', or 'array'
    this.mode = (options && options.mode) || 'diffDeep';
  }


  apply(fn, inputs: any[]) {
    for (let i = 0, len = this.inputsSegments.length; i < len; i++) {
      const input = this.model._get(this.inputsSegments[i]);
      inputs.push(this.copyInput ? util.deepCopy(input) : input);
    }
    return fn.apply(this.model, inputs);
  }

  get() {
    return this.apply(this.getFn, []);
  }

  set(value, pass?: Object): void {
    if (!this.setFn) return;
    const out = this.apply(this.setFn, [value]);
    if (!out) return;
    const inputsSegments = this.inputsSegments;
    const model = this.model.pass(pass, true);
    for (const key in out) {
      var value = (this.copyOutput) ? util.deepCopy(out[key]) : out[key];
      this._setValue(model, inputsSegments[key], value);    /// TODO: segments is a string from here! see below
    }
  }

  onInput(pass?: Object) {
    const value = (this.copyOutput) ? util.deepCopy(this.get()) : this.get();
    this._setValue(this.model.pass(pass, true), this.fromSegments, value);
    return value;
  }

  onOutput(pass?: Object): void {
    const value = this.model._get(this.fromSegments);
    this.set(value, pass);
  }

  // TODO: segments could be a string sometimes?! Does it hurt?
  _setValue(model: Model, segments: string[], value): void {
    if (this.mode === 'diffDeep') {
      model._setDiffDeep(segments, value);
    } else if (this.mode === 'arrayDeep') {
      model._setArrayDiffDeep(segments, value);
    } else if (this.mode === 'array') {
      model._setArrayDiff(segments, value);
    } else {
      model._setDiff(segments, value);
    }
  }
}
