import util from '../util';
import Model from './Model';
import defaultFns from './defaultFns';

Model.INITS.push((model: Model) => {
  model.root._filters = new Filters(model);
  model.on('all', filterListener);
  function filterListener(segments, eventArgs) {
    const pass = eventArgs[eventArgs.length - 1];
    const map = model.root._filters.fromMap;
    for (const path in map) {
      const filter = map[path];
      if (pass.$filter === filter) continue;
      if (
        util.mayImpact(filter.segments, segments) ||
        (filter.inputsSegments && util.mayImpactAny(filter.inputsSegments, segments))
      ) {
        filter.update(pass);
      }
    }
  }
});

function parseFilterArguments(model, args) {
  const fn = args.pop();
  let options;
  if (!model.isPath(args[args.length - 1])) {
    options = args.pop();
  }
  const path = model.path(args.shift());
  let i = args.length;
  while (i--) {
    args[i] = model.path(args[i]);
  }
  return {
    path: path,
    inputPaths: (args.length) ? args : null,
    options: options,
    fn: fn
  };
}

Model.prototype.filter = function() {
  const args = Array.prototype.slice.call(arguments);
  const parsed = parseFilterArguments(this, args);
  return this.root._filters.add(
    parsed.path,
    parsed.fn,
    null,
    parsed.inputPaths,
    parsed.options
  );
};

Model.prototype.sort = function() {
  const args = Array.prototype.slice.call(arguments);
  const parsed = parseFilterArguments(this, args);
  return this.root._filters.add(
    parsed.path,
    null,
    parsed.fn || 'asc',
    parsed.inputPaths,
    parsed.options
  );
};

Model.prototype.removeAllFilters = function(subpath) {
  const segments = this._splitPath(subpath);
  this._removeAllFilters(segments);
};
Model.prototype._removeAllFilters = function(segments) {
  const filters = this.root._filters.fromMap;
  for (const from in filters) {
    if (util.contains(segments, filters[from].fromSegments)) {
      filters[from].destroy();
    }
  }
};

class FromMap {
  [from: string]: Filter;
}

interface FilterOptions {
  skip: number;
  limit: number;
}

type compareFn = (a: any, b: any) => number;

export class Filters {

  public model: Model;
  public fromMap: FromMap;


  constructor(model: Model) {
    this.model = model;
    this.fromMap = new FromMap();
  }

  add(path, filterFn, sortFn, inputPaths, options) {
    return new Filter(this, path, filterFn, sortFn, inputPaths, options);
  }

  toJSON() {
    const out = [];
    for (const from in this.fromMap) {
      const filter = this.fromMap[from];
      // Don't try to bundle if functions were passed directly instead of by name
      if (!filter.bundle) continue;
      const args = [from, filter.path, filter.filterName, filter.sortName, filter.inputPaths];
      if (filter.options) args.push(filter.options);
      out.push(args);
    }
    return out;
  }
}


class Filter {
  private filters: Filters;
  private model: Model;

  public path: string;
  public segments: string[];

  public filterName: string;
  public sortName: string;

  private filterFn: Function;   // TODO: args and return?
  private sortFn: compareFn;

  public inputPaths: string[];
  public inputsSegments: string[];

  private idsSegments: string[];
  private from: string;
  private fromSegments: string[];

  public skip: number;
  public limit: number;

  public options: FilterOptions;
  public bundle: boolean;

  constructor(
    filters: Filters,
    path: string,
    filterFn: Function | string,
    sortFn: compareFn | string,
    inputPaths: string[],
    options: FilterOptions
  ) {
    this.filters = filters;
    this.model = filters.model.pass({$filter: this});
    this.path = path;
    this.segments = path.split('.');
    this.filterName = null;
    this.sortName = null;
    this.bundle = true;
    this.filterFn = null;
    this.sortFn = null;
    this.inputPaths = inputPaths;
    this.inputsSegments = null;
    if (inputPaths) {
      this.inputsSegments = [];
      for (let i = 0; i < this.inputPaths.length; i++) {
        const segments = this.inputPaths[i].split('.');
        this.inputsSegments.push(segments);
      }
    }
    this.options = options;
    this.skip = options && options.skip;
    this.limit = options && options.limit;
    if (filterFn) this.filter(filterFn);
    if (sortFn) this.sort(sortFn);
    this.idsSegments = null;
    this.from = null;
    this.fromSegments = null;
  }

  filter(fn: Function | string) {
    if (typeof fn === 'function') {
      this.filterFn = fn;
      this.bundle = false;
      return this;
    } else if (typeof fn === 'string') {
      this.filterName = fn;
      this.filterFn = this.model.root._namedFns[fn] || defaultFns[fn];
      if (!this.filterFn) {
        throw new TypeError('Filter function not found: ' + fn);
      }
    }
    return this;
  }

  sort(fn: compareFn | string): Filter {
    if (!fn) fn = 'asc';
    if (typeof fn === 'function') {
      this.sortFn = fn;
      this.bundle = false;
      return this;
    } else if (typeof fn === 'string') {
      this.sortName = fn;
      this.sortFn = this.model.root._namedFns[fn] || defaultFns[fn];
      if (!this.sortFn) {
        throw new TypeError('Sort function not found: ' + fn);
      }
    }
    return this;
  }

  _slice(results: Array<>): Array<> {
    if (this.skip == null && this.limit == null) return results;
    const begin = this.skip || 0;
    // A limit of zero is equivalent to setting no limit
    let end;
    if (this.limit) end = begin + this.limit;
    return results.slice(begin, end);
  }

  getInputs(): Array<> {
    if (!this.inputsSegments) return;
    const inputs = [];
    for (let i = 0, len = this.inputsSegments.length; i < len; i++) {
      const input = this.model._get(this.inputsSegments[i]);
      inputs.push(input);
    }
    return inputs;
  }

  callFilter(items, key, inputs) {
    const item = items[key];
    return (inputs) ?
      this.filterFn.apply(this.model, [item, key, items].concat(inputs)) :
      this.filterFn.call(this.model, item, key, items);
  }

  ids() {
    const items = this.model._get(this.segments);
    let ids = [];
    if (!items) return ids;
    if (Array.isArray(items)) {
      throw new Error('model.filter is not currently supported on arrays');
    }
    if (this.filterFn) {
      const inputs = this.getInputs();
      for (const key in items) {
        if (items.hasOwnProperty(key) && this.callFilter(items, key, inputs)) {
          ids.push(key);
        }
      }
    } else {
      ids = Object.keys(items);
    }
    const sortFn = this.sortFn;
    if (sortFn) {
      ids.sort((a, b) => sortFn(items[a], items[b]));
    }
    return this._slice(ids);
  }

  get() {
    const items = this.model._get(this.segments);
    const results = [];
    if (Array.isArray(items)) {
      throw new Error('model.filter is not currently supported on arrays');
    }
    if (this.filterFn) {
      const inputs = this.getInputs();
      for (var key in items) {
        if (items.hasOwnProperty(key) && this.callFilter(items, key, inputs)) {
          results.push(items[key]);
        }
      }
    } else {
      for (var key in items) {
        if (items.hasOwnProperty(key)) {
          results.push(items[key]);
        }
      }
    }
    if (this.sortFn) results.sort(this.sortFn);
    return this._slice(results);
  }

  update(pass) {
    const ids = this.ids();
    this.model.pass(pass, true)._setArrayDiff(this.idsSegments, ids);
  }

  ref(from: string) {
    from = this.model.path(from);
    this.from = from;
    this.fromSegments = from.split('.');
    this.filters.fromMap[from] = this;
    this.idsSegments = ['$filters', from.replace(/\./g, '|')];
    this.update();
    return this.model.refList(from, this.path, this.idsSegments.join('.'));
  }

  destroy() {
    delete this.filters.fromMap[this.from];
    this.model._removeRef(this.idsSegments);
    this.model._del(this.idsSegments);
  }
}
