// import { utils } from './utils';
import { InstanceFactory } from './component';
import { IRecord, IField, RecordState, DataEventType, RecordSetSource } from './data';
import { application } from './application';
import { IService, IResponse } from './service';
import { utils } from './utils';

// Interfaces

/** Enumerates types of events generated by data set */
export enum DataSetEventType { Refreshed, Updated };

/** Record state for cached updates */
export enum RecordUpdateType { Delete = 1, Update = 2, Insert = 3 };

/** Event type that raised when something changes in the data set */
export interface IOnDataSetChangeEvent {
    (eventType: DataSetEventType, data?: any): void;
}

/** Describes a datasource link */
export interface IDataSetLink {
    onChange(eventType: DataSetEventType, data: any): void;
}

/** Describes an object that maintains data source links */
export interface IDataSet {
    addLink(link: IDataSetLink): void;
    removeLink(link: IDataSetLink): void;
    notifyLinks(eventType: DataSetEventType, data?: any): void;
}

/** Describes an object containing data table */
export interface IDataTable extends IDataSet {
    tableName: string;
    fields: IField[];
    records: IRecord[];
    recordsUpdates: RecordsUpdates;
    createRecord(): IRecord;
    fillRecords(records: IRecord[]): void;
    fill(): Promise<void>;
    applyUpdates(): Promise<void>;
}

/** Describes an object containing several data tables */
export interface IDataTableSet {
    tables: IDataTable[];
    adapter: IDataTableSetAdapter;
    tableByName(tableName: string): IDataTable;
    fill(): Promise<void>;
    applyUpdates(): Promise<void>;
}

/** Describes an object for remote data manipulation */
export interface IDataAdapter {
    execute(command: string, params: any): Promise<any>;
}

/** Describes an object for table remote data manipulation */
export interface IDataTableAdapter extends IDataAdapter {
    fill(table: IDataTable, params?: any): Promise<void>;
    applyUpdates(table: IDataTable): Promise<void>;
}

/** Describes an object document remote data manipulation */
export interface IDataTableSetAdapter extends IDataAdapter {
    fill(tableSet: IDataTableSet): Promise<void>;
    applyUpdates(tableSet: IDataTableSet): Promise<void>;
}

// Implementation

/** Object contaning its metainfo and table */
export class Record implements IRecord {
    /** Fields information, in general not needed because DataTable contains its own */
    public static metaInfo = {
        /* implement in descendats, e:g:
            name: {
                dataType: 'string',
                dataSize: 20,
                required: false
            }
        */
    };
    public table: DataTable<Record>;
}

/** Record link used in cached updates */
class RecordUpdate {
    constructor(public record: Record, public updateType?: RecordUpdateType) {
    }
}

/** Used for cached updates */
class RecordsUpdates {
    protected _updates: RecordUpdate[] = [];
    public get updates(): RecordUpdate[] {
        return this._updates;
    }

    public clear() {
        this._updates = [];
    }

    public addUpdate(rec: Record, updateType: RecordUpdateType): RecordUpdate {
        let idx = this.getUpdateIndex(rec);
        if (idx === undefined)
            idx = this._updates.push(new RecordUpdate(rec)) - 1;
        let update = this.updates[idx];

        // inserted and then deleted records just removing from updates
        if (updateType === RecordUpdateType.Delete && (update.updateType !== undefined && update.updateType === RecordUpdateType.Insert)) {
            this.updates.splice(idx);
            return;
        }

        // updates other than Modified have higher priority
        if (!update.updateType || (update.updateType && update.updateType === RecordUpdateType.Update))
            update.updateType = updateType;

        return update;
    }

    // Returns updates as service params
    public getUpdateParams() {
        let upd: RecordUpdate, rec: Record, fields: IField[], param, result = [];
        for (let i = 0; i < this._updates.length; i++) {
            upd = this._updates[i];
            rec = upd.record;
            fields = rec.table.getMetaInfo();
            param = {
                data: {},
                updateType: RecordUpdateType[upd.updateType]
            };
            for (let j = 0; j < fields.length; j++) {
                if (rec.hasOwnProperty(fields[j].fieldName))
                    param.data[fields[j].fieldName] = rec[fields[j].fieldName];
            }
            result.push(param);
        }
        return result;
    }

    protected getUpdateIndex(rec: Record): number {
        for (let i = 0; i < this.updates.length; i++)
            if (this.updates[i].record === rec)
                return i;
    }
}

/**
 * Used for maintain DataSources inside DataSet 
 */
export class DataSetLink<T extends IDataSet> implements IDataSetLink {
    public onChangeEvent: IOnDataSetChangeEvent;
    protected _dataSet: T;

    constructor(onChangeEvent: IOnDataSetChangeEvent) {
        this.onChangeEvent = onChangeEvent;
    }

    public get dataSet(): T { return this._dataSet; }
    public set dataSet(value: T) { this.setDataSet(value); }

    public onChange(eventType: DataSetEventType, data?: any): void {
        if (this.onChangeEvent)
            this.onChangeEvent(eventType, data);
    }

    protected setDataSet(value: T) {
        if (this._dataSet !== value) {
            if (this._dataSet)
                this._dataSet.removeLink(this);
            this._dataSet = value;
            if (this._dataSet)
                this._dataSet.addLink(this);
            this.onChange(DataSetEventType.Refreshed);
        }
    }
}

/** 
 * DataSet containing one table
 */
export class DataTable<R extends Record> implements IDataTable {
    /** Table name, used in default DataAdapter */
    public tableName: string;
    /** Fields returned by service */
    public fields: IField[] = [];
    /** Records returned by service */
    public records: R[] = [];
    /** Remote crud adapter */
    public adapter: IDataTableAdapter;
    /** Records constructor */
    public recordFactory: InstanceFactory<R>;

    /** Modified records */
    protected _recordsUpdates = new RecordsUpdates();
    public get recordsUpdates(): RecordsUpdates {
        return this._recordsUpdates;
    }

    /** Links to maintained DataSources */
    protected links: IDataSetLink[] = [];

    constructor(recordFactory?: { new (): R }, owner?: DataTableSet, tableName?: string, adapter?: IDataTableAdapter) {
        this.recordFactory = recordFactory;
        this.tableName = tableName;
        if (owner)
            owner.tables.push(this);
        this.adapter = adapter;
        if (!this.adapter)
            this.adapter = new DataTableAdapter(tableName);
    }

    public add(record?: R): R {
        if (!record)
            record = this.createRecord();
        this.recordsUpdates.addUpdate(record, RecordUpdateType.Insert);
        this.records.push(record);
        this.notifyLinks(DataSetEventType.Refreshed);
        return record;
    }

    public delete(index: number) {
        let rec = this.records[index];
        this.recordsUpdates.addUpdate(rec, RecordUpdateType.Delete);
        this.records.splice(index, 1);
        this.notifyLinks(DataSetEventType.Refreshed);
    }

    public update(record: R) {
        this.recordsUpdates.addUpdate(record, RecordUpdateType.Update);
        this.notifyLinks(DataSetEventType.Refreshed);
    }

    public getMetaInfo(): any {
        if (this.recordFactory && (<any>this.recordFactory).metaInfo && !utils.isEmptyObject((<any>this.recordFactory).metaInfo))
            return (<any>this.recordFactory).metaInfo;
        else
            return this.fields;
    }

    // IDataTable implementation

    public addLink(link: IDataSetLink): void {
        this.links.push(link);
    }

    public removeLink(link: IDataSetLink): void {
        let num = this.links.indexOf(link);
        if (num >= 0)
            this.links.splice(num);
    }

    public notifyLinks(eventType: DataSetEventType, data?: any): void {
        for (let i = 0; i < this.links.length; i++) {
            this.links[i].onChange(eventType, data);
        }
    }

    public createRecord(): R {
        let newRec: Record;
        if (this.recordFactory)
            newRec = new this.recordFactory();
        else
            newRec = new Record();
        newRec.table = this;
        return <R>newRec;
    }

    public fill(params?: any): Promise<void> {
        return this.adapter.fill(this, params).then(() => {
            this.notifyLinks(DataSetEventType.Refreshed);
        });
    }

    public fillRecords(data): void {
        this.records = [];
        this.fields = [];
        this.recordsUpdates.clear();
        if (Array.isArray(data.records) && data.records.length > 0) {
            // metainfo
            this.fields = RecordSetSource.getObjectFields(data.records[0]);
            // Records instancing
            let rec: R;
            for (let i = 0; i < data.records.length; i++) {
                rec = this.createRecord();
                for (let field in data.records[i]) {
                    if (data.records[i].hasOwnProperty(field) /*&& rec.hasOwnProperty(field)*/)
                        rec[field] = data.records[i][field];
                }
                this.records.push(rec);
            }
        }
    }

    public applyUpdates(): Promise<void> {
        if (this.recordsUpdates.updates.length === 0)
            return;
        return this.adapter.applyUpdates(this).then(() => {
            this.notifyLinks(DataSetEventType.Updated);
        });
    }
}

/** 
 * Data table crud adapter  
 */
export class DataTableAdapter implements IDataTableAdapter {
    public adapter: string;
    public service: IService;
    public fillMethod = 'fill';
    public applyUpdatesMethod = 'applyUpdates';

    constructor(adapter: string) {
        this.adapter = adapter;
    }

    public execute(command: string, params?: any): Promise<any> {
        return this.getService().execute(this.adapter, command, params).then((response: IResponse) => {
            return response.data;
        });
    }

    public fill(table: IDataTable, params?: any): Promise<void> {
        return this.execute(this.fillMethod, params).then((data) => {
            if (!data || !data.records)
                throw 'Service did not returned any data';
            table.fillRecords(data);
        });
    }

    public applyUpdates(table: IDataTable): Promise<void> {
        let params = table.recordsUpdates.getUpdateParams();
        if (!params)
            return;
        return this.execute(this.applyUpdatesMethod, params).then(() => {
            table.recordsUpdates.clear();
        });
    }

    protected getService(): IService {
        return this.service || application.obj.service;
    }
}

/** 
 * DataTable's DataSource  
 */
export class TableDataSource<R extends Record> extends RecordSetSource {
    protected _data: DataSetLink<DataTable<R>>;

    constructor(dataTable?: DataTable<R>) {
        super();
        this._data = new DataSetLink<DataTable<R>>((eventType: DataSetEventType, data: any) => {
            if (eventType === DataSetEventType.Refreshed) {
                this.setRecords(this.dataTable.records);
                if (!this._state)
                    this.setState(RecordState.Browse);
                this.notifyLinks(DataEventType.Refreshed);
            }
        });
        this._data.dataSet = dataTable;
    }

    public get dataTable(): DataTable<R> {
        return this._data.dataSet;
    }
    public set dataTable(dataTable: DataTable<R>) {
        if (this._data.dataSet !== dataTable) {
            if (this._data.dataSet)
                this._data.dataSet.removeLink(this._data);
            dataTable.addLink(this._data);
        }
    }

    public post() {
        if (this._state && this._state !== RecordState.Browse) {
            this.dataTable.update(<R>this.current);
            super.post();
        }
    }

    public delete(): void {
        this.checkCurrent();
        this.dataTable.delete(this._curIndex);
        this.setState(RecordState.Browse);
        if (this._curIndex >= this._records.length) {
            this._curIndex = this._records.length - 1;
            this.notifyLinks(DataEventType.CursorMoved);
        }
    }

    public insert(): void {
        this.checkList();
        this.doAutoPost();
        this.dataTable.add();
        this._curIndex = this._records.length - 1;
        this._oldValue = {};
        this.setState(RecordState.Insert);
        this.notifyLinks(DataEventType.CursorMoved);
    }
}

/** 
 * DataSet containing several tables 
 */
export class DataTableSet implements IDataTableSet {
    /** Maintained tables */
    public tables: IDataTable[] = [];
    /** Remote crud adapter */
    public adapter: IDataTableSetAdapter;

    constructor(adapter: IDataTableSetAdapter | string) {
        if (typeof adapter === 'object')
            this.adapter = adapter;
        else {
            // let p = Object.getPrototypeOf(this);
            // let c = Component.getFunctionName(p.constructor);
            this.adapter = new DataTableSetAdapter(adapter);
        }
    }

    // IDataTableSet implementation

    /** Returns table by its name */
    public tableByName(tableName: string): IDataTable {
        for (let i = 0; i < this.tables.length; i++)
            if (this.tables[i].tableName === tableName)
                return this.tables[i];
    }

    /** Fills tables using application service */
    public fill(): Promise<void> {
        return this.adapter.fill(this).then(() => {
            for (let i = 0; i < this.tables.length; i++)
                this.tables[i].notifyLinks(DataSetEventType.Refreshed);
        });
    }

    /** Updates tables using application service */
    public applyUpdates(): Promise<void> {
        return this.adapter.applyUpdates(this).then(() => {
            for (let i = 0; i < this.tables.length; i++)
                this.tables[i].notifyLinks(DataSetEventType.Updated);
        });
    }

}

/** 
 * Table set crud adapter  
 */
export class DataTableSetAdapter implements IDataTableSetAdapter {
    public adapter: string;
    public service: IService;

    constructor(adapter: string) {
        this.adapter = adapter;
    }

    public execute(command: string, params?: any): Promise<any> {
        return this.getService().execute(this.adapter, command, params).then((response: IResponse) => {
            return response.data;
        });
    }

    public fill(tableSet: IDataTableSet): Promise<void> {
        return this.execute('fill').then((data) => {
            let dataTable;
            for (let table in data) {
                if (data.hasOwnProperty(table) && data[table].hasOwnProperty('records') && (dataTable === tableSet.tableByName(table))) {
                    dataTable.fillRecords(data[table]);
                }
            }
            return;
        });
    }

    public applyUpdates(tableSet: IDataTableSet): Promise<void> {
        let params = {};
        for (let i = 0; i < tableSet.tables.length; i++) {
            if (tableSet.tables[i].recordsUpdates.updates.length > 0)
                params[tableSet.tables[i].tableName] = tableSet.tables[i].recordsUpdates.getUpdateParams();
        }
        return this.execute('applyUpdates', params).then(() => {
            for (let i = 0; i < tableSet.tables.length; i++) {
                tableSet.tables[i].recordsUpdates.clear();
            }
        });
    }

    protected getService(): IService {
        return this.service || application.obj.service;
    }
}

// example code 

/*

class Customer extends Record {
    name: string;
    phone: string;
    static metaInfo =
    [
        {
            fieldName: 'name',
            dataType: 'string',
            dataSize: 20,
            required: true
        },
        {
            fieldName: 'phone',
            dataType: 'string',
            dataSize: 20,
            required: false
        },
    ]
}

class Order extends Record {
    ...
}

class OrderDataSet extends DataTableSet {
    order = new DataTable(Order, this, 'order');
    customer = new DataTable(Customer, this, 'customer');
}

let order = new OrderDataSet();
order.customer.edit();
order.customer.name = 'Smith';
order.customer.post();
order.applyUpdates();

let customerTable = new DataTable(Customer);

*/
