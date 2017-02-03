import Model from './Model';


export class Ref {
  public model: Model;

  public from: string;
  public to: string;

  public fromSegments: string[];
  public toSegments: string[];
  public parentTos: string[];

  public updateIndices: boolean;


  constructor(model: Model, from: string, to: string, options?: { updateIndices: boolean }) {
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

export class Refs {

  constructor(
    public parentToPathMap = new PathListMap(),
    public toPathMap = new PathListMap(),
    public fromPathMap = new PathMap()
  ) {}

  add(ref: Ref) {
    this.fromPathMap.add(ref.fromSegments, ref);
    this.toPathMap.add(ref.toSegments, ref);
    for (let i = 0, len = ref.parentTos.length; i < len; i++) {
      this.parentToPathMap.add(ref.parentTos[i].split('.'), ref);
    }
  }

  remove(from?: string): Ref {
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

    for (let i = 0, len = refs.length; i < len; i++) {
      const ref = refs[i];
      out.push([ref.from, ref.to]);
    }
    return out;
  }
}



// type PathMapType = { [path: string]: PathMapType } | { $item: Ref } ;
type PathMapType = {
  [path: string]: PathMapType | Ref
};


export class PathMap {
  private map: PathMapType;

  constructor() {
    this.map = {};
  }

  add(segments: string[], item: Ref): void {
    let map = this.map;

    for (let i = 0, len = segments.length - 1; i < len; i++) {
      map[segments[i]] = map[segments[i]] || {}; // if nothing there yet, create empty map
      map = <PathMapType>map[segments[i]];
    }

    map[segments[segments.length - 1]] = { [Symbol.for('$item')]: item};
  }

  get(segments: string[]): Ref {
    const val = this._get(segments);

    return (val && val[Symbol.for('$item')]) ? <Ref>val[Symbol.for('$item')] : void 0;
  }

  private _get(segments: string[]): PathMapType {
    let val = this.map;

    for (let i = 0, len = segments.length; i < len; i++) {
      val = <PathMapType>val[segments[i]];
      if (!val) return;
    }

    return val;
  }

  getList(segments: string[]): Ref[] {
    const obj = this._get(segments);

    return flattenObj(obj);
  }

  delete(segments: string[]): void {
    del(this.map, segments.slice(0), true);
  }
}

function flattenObj(obj: PathMapType): Ref[] {
  if (!obj) return [];
  console.log('****** FLATTEN OBJ ******');

  // obj[Symbol.for('$item')] is a Ref, everything else a PathMapType
  let arr: Ref[] = [];
  if (obj[Symbol.for('$item')]) arr.push(<Ref>obj[Symbol.for('$item')]);

  const keys = Object.keys(obj);
  for (let i = 0, len = keys.length; i < len; i++) {
    arr = arr.concat(flattenObj(<PathMapType>obj[keys[i]]));
  }

  return arr;
}

function del(map, segments: string[], safe: boolean): boolean {
  const segment = segments.shift();

  if (!segments.length) {
    if (safe) {
      delete map[segment];
      return false;
    } else {
      return true;
    }
  }

  const nextMap = map[segment];
  if (!nextMap) return true;

  const nextSafe = (Object.keys(nextMap).length > 1);
  const remove = del(nextMap, segments, nextSafe);

  if (remove) {
    if (safe) {
      delete map[segment];
      return false;
    } else {
      return true;
    }
  }
}


type PathMapListType = { [path: string]: (PathMapListType | Ref[]) };

export class PathListMap {
  private map: PathMapListType;

  constructor() {
    this.map = {};
  }

  add(segments: string[], item: Ref): void {
    let map = this.map;

    for (let i = 0, len = segments.length - 1; i < len; i++) {
      map[segments[i]] = map[segments[i]] || { [Symbol.for('$items')]: [] };
      map = <PathMapListType>map[segments[i]];
    }

    const segment = segments[segments.length - 1];

    map[segment] = map[segment] || {[Symbol.for('$items')]: []};
    map[segment][Symbol.for('$items')].push(item);
  }

  get(segments: string[], onlyAtLevel: boolean = false): Ref[] {
    let val = this.map;

    for (let i = 0, len = segments.length; i < len; i++) {
      val = <PathMapListType>val[segments[i]];
      if (!val) return [];
    }

    if (onlyAtLevel) return (<Ref[]>val[Symbol.for('$items')] || []);

    return flatten(val);
  }

  delete(segments: string[], item: Ref): void {
    delList(this.map, segments.slice(0), item, true);
  }
}

function flatten(obj: PathMapListType): Ref[] {
  const arr: Ref[] = <Ref[]>obj[Symbol.for('$items')] || [];
  console.log('****** FLATTEN ******');

  const keys = Object.keys(obj);
  for (let i = 0, len = keys.length; i < len; i++) {
    arr.concat(flatten(<PathMapListType>obj[keys[i]]));
  }

  return arr;
}

function delList(map: PathMapListType, segments: string[], item: Ref, safe): boolean {
  const segment = segments.shift();

  if (!segments.length) {
    if (!map[segment] || !map[segment][Symbol.for('$items')]) return true;

    const items = map[segment][Symbol.for('$items')];
    const keys = Object.keys(map[segment]);

    if (items.length < 2 && keys.length < 2) {
      if (safe) {
        delete map[segment];
        return false;
      } else {
        return true;
      }
    } else {
      const i = items.indexOf(item);

      if (i > -1) items.splice(i, 1);

      return false;
    }
  }

  const nextMap = map[segment];
  if (!nextMap) return true;

  const nextSafe = (Object.keys(nextMap).length > 2 || nextMap[Symbol.for('$items')].length);
  const remove = delList(<PathMapListType>nextMap, segments, item, nextSafe);

  if (remove) {
    if (safe) {
      delete map[segment];
      return false;
    } else {
      return true;
    }
  }
}
