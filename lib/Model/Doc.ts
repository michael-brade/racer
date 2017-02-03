import Model from './Model';

export abstract class Doc {
  protected collectionName: string;
  protected id: string;
  protected collectionData;

  public shareDoc;
  public data;

  constructor(model: Model, collectionName: string, id: string, data, collection) {
    this.collectionName = collectionName;
    this.id = id;
    this.collectionData = model && model.data[collectionName];
  }

  path(segments?: string[]): string {
    let path = this.collectionName + '.' + this.id;
    if (segments && segments.length) path += '.' + segments.join('.');
    return path;
  }


  abstract get(segments?: string[]);
  abstract set(segments: string[], value, cb: Function);
  abstract increment(segments: string[], byNumber: number, cb);
  abstract move(segments: string[], from: number, to: number, howMany: number, cb);

  protected _errorMessage(description: string, segments: string[], value): string {
    return description + ' at ' + this.path(segments) + ': ' +
      JSON.stringify(value, null, 2);
  }
}
