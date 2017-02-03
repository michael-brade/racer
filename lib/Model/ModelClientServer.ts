import { Model, ChildModel } from './Model';

import CollectionCounter from './CollectionCounter';
import { Contexts, Context } from './contexts';
import { Doc } from './Doc';
import Query, { Queries } from './Query';


export interface ModelClientServer extends Model {
    root: ModelClientServer;

    // connection
    _preventCompose: boolean;
    connection: any;
    socket: any;
    _createSocket: (bundle) => any;

    // subscriptions
    fetchOnly: boolean;
    unloadDelay: number;
    _fetchedDocs: CollectionCounter;
    _subscribedDocs: CollectionCounter;

    // Query
    _queries: Queries;

    // contexts
    _contexts: Contexts;
    _context: Context;
}

export interface ModelClientServer extends Model {


    /** //////////////////////
     // unbundle
    //////////////////////*/

    unbundle(data): void;


    /** //////////////////////
    // connection
    //////////////////////*/

    preventCompose(): ChildModel;
    allowCompose(): ChildModel;
    createConnection(bundle: any, dummy): void; // on server: backend, req
    _finishCreateConnection(): void;
    connect(): void;
    disconnect(): void;
    reconnect(): void;
    close(cb: any): void;
    getAgent(): any;
    _isLocal(name: string): boolean;
    _getDocConstructor(name: string): {
        new (model: Model, collectionName: string, id: string, data, collection): Doc;
    };
    hasPending(): boolean;
    hasWritePending(): boolean;
    whenNothingPending(cb: any): any;


    /** //////////////////////
    // subscriptions
    //////////////////////*/

    fetch(): this;
    unfetch(): this;
    subscribe(): this;
    unsubscribe(): this;
    _forSubscribable(argumentsObject: any, method: any): void;
    fetchDoc(collectionName: string, id: string, cb?: any): void;
    subscribeDoc(collectionName: string, id: string, cb?: any): any;
    unfetchDoc(collectionName: string, id: string, cb?: any): any;
    unsubscribeDoc(collectionName: string, id: string, cb?: any): any;
    _maybeUnloadDoc(collectionName: string, id: string): void;
    _hasDocReferences(collectionName: string, id: string): boolean;
    unbundle(data: any): void;


    /** //////////////////////
    // Query
    //////////////////////*/

    query(collectionName: string, expression: any, options: any): Query;
    sanitizeQuery(expression: any): any;
    _initQueries(items: any): void;


    /** //////////////////////
    // contexts
    //////////////////////*/

    context(id: string): ChildModel;
    setContext(id: string): void;
    getOrCreateContext(id: string): Context;
    unload(id?: string): void;
    unloadAll(): void;
}

export declare function Passed(previous: any, value: any): void;
