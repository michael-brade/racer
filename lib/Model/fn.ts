import util from '../util';
import Model from './Model';
import defaultFns from './defaultFns';

class NamedFns {}

Model.INITS.push(model => {
  model.root._namedFns = new NamedFns();
  model.root._fns = new Fns(model);
  model.on('all', fnListener);
  function fnListener(segments, eventArgs) {
    const pass = eventArgs[eventArgs.length - 1];
    const map = model.root._fns.fromMap;
    for (const path in map) {
      const fn = map[path];
      if (pass.$fn === fn) continue;
      if (util.mayImpactAny(fn.inputsSegments, segments)) {
        // Mutation affecting input path
        fn.onInput(pass);
      } else if (util.mayImpact(fn.fromSegments, segments)) {
        // Mutation affecting output path
        fn.onOutput(pass);
      }
    }
  }
});

Model.prototype.fn = function(name, fns) {
  this.root._namedFns[name] = fns;
};

function parseStartArguments(model, args, hasPath) {
  const last = args.pop();
  let fns, name;
  if (typeof last === 'string') {
    name = last;
  } else {
    fns = last;
  }
  let path;
  if (hasPath) {
    path = model.path(args.shift());
  }
  let options;
  if (!model.isPath(args[args.length - 1])) {
    options = args.pop();
  }
  let i = args.length;
  while (i--) {
    args[i] = model.path(args[i]);
  }
  return {
    name: name,
    path: path,
    inputPaths: args,
    fns: fns,
    options: options
  };
}

Model.prototype.evaluate = function() {
  const args = Array.prototype.slice.call(arguments);
  const parsed = parseStartArguments(this, args, false);
  return this.root._fns.get(parsed.name, parsed.inputPaths, parsed.fns, parsed.options);
};

Model.prototype.start = function() {
  const args = Array.prototype.slice.call(arguments);
  const parsed = parseStartArguments(this, args, true);
  return this.root._fns.start(parsed.name, parsed.path, parsed.inputPaths, parsed.fns, parsed.options);
};

Model.prototype.stop = function(subpath) {
  const path = this.path(subpath);
  this._stop(path);
};
Model.prototype._stop = function(fromPath) {
  this.root._fns.stop(fromPath);
};

Model.prototype.stopAll = function(subpath) {
  const segments = this._splitPath(subpath);
  this._stopAll(segments);
};
Model.prototype._stopAll = function(segments) {
  const fns = this.root._fns.fromMap;
  for (const from in fns) {
    const fromSegments = fns[from].fromSegments;
    if (util.contains(segments, fromSegments)) {
      this._stop(from);
    }
  }
};

class FromMap {}

class Fns {
  constructor(model) {
    this.model = model;
    this.nameMap = model.root._namedFns;
    this.fromMap = new FromMap();
  }

  get(name, inputPaths, fns, options) {
    fns || (fns = this.nameMap[name] || defaultFns[name]);
    const fn = new Fn(this.model, name, null, inputPaths, fns, options);
    return fn.get();
  }

  start(name, path, inputPaths, fns, options) {
    fns || (fns = this.nameMap[name] || defaultFns[name]);
    const fn = new Fn(this.model, name, path, inputPaths, fns, options);
    this.fromMap[path] = fn;
    return fn.onInput();
  }

  stop(path) {
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
      const args = [fn.from].concat(fn.inputPaths);
      if (fn.options) args.push(fn.options);
      args.push(fn.name);
      out.push(args);
    }
    return out;
  }
}

class Fn {
  constructor(model, name, from, inputPaths, fns, options) {
    this.model = model.pass({$fn: this});
    this.name = name;
    this.from = from;
    this.inputPaths = inputPaths;
    this.options = options;
    if (!fns) {
      throw new TypeError('Model function not found: ' + name);
    }
    this.getFn = fns.get || fns;
    this.setFn = fns.set;
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

  apply(fn, inputs) {
    for (let i = 0, len = this.inputsSegments.length; i < len; i++) {
      const input = this.model._get(this.inputsSegments[i]);
      inputs.push(this.copyInput ? util.deepCopy(input) : input);
    }
    return fn.apply(this.model, inputs);
  }

  get() {
    return this.apply(this.getFn, []);
  }

  set(value, pass) {
    if (!this.setFn) return;
    const out = this.apply(this.setFn, [value]);
    if (!out) return;
    const inputsSegments = this.inputsSegments;
    const model = this.model.pass(pass, true);
    for (const key in out) {
      var value = (this.copyOutput) ? util.deepCopy(out[key]) : out[key];
      this._setValue(model, inputsSegments[key], value);
    }
  }

  onInput(pass) {
    const value = (this.copyOutput) ? util.deepCopy(this.get()) : this.get();
    this._setValue(this.model.pass(pass, true), this.fromSegments, value);
    return value;
  }

  onOutput(pass) {
    const value = this.model._get(this.fromSegments);
    return this.set(value, pass);
  }

  _setValue(model, segments, value) {
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
