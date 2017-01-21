import Model from './Model';

export default class Doc {
  protected collectionName: string;
  protected id;
  protected collectionData;

  constructor(model: Model, collectionName: string, id) {
    this.collectionName = collectionName;
    this.id = id;
    this.collectionData = model && model.data[collectionName];
  }

  path(segments): string {
    let path = this.collectionName + '.' + this.id;
    if (segments && segments.lenth) path += '.' + segments.join('.');
    return path;
  }

  protected _errorMessage(description, segments, value): string {
    return description + ' at ' + this.path(segments) + ': ' +
      JSON.stringify(value, null, 2);
  }
}
