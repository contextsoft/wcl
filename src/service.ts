/** Server communication protocols and routines */

// import { utils } from './Utils';
import { application } from './Application';

export interface IResponse {
    data: any;
    error?: string;
    errorCallstack?: string;
}

interface IOnData {
    (data: any): any;
}

export interface IService {
    url: string;
    authenticated: boolean;
    username: string;
    login(username?: string, password?: string): Promise<any>;
    logout();
    execute(className: string, methodName: string, params?: any): Promise<IResponse>;
}

export class Ajax {
    public static parseJSON(data: string) {
        let r;
        try {
            r = JSON.parse(data);
        }
        catch (e) {
            r = data;
        }
        return r;
    }

    public static send(url: string, callback: IOnData, method: string, data?, async = true) {
        let x = Ajax.getXHR();
        x.open(method, url, async);
        x.onreadystatechange = () => {
            if (x.readyState === 4) {
                callback(Ajax.parseJSON(x.responseText));
            }
        };
        if (method === 'POST') {
            x.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
        }
        x.send(data);
    }

    public static get(url: string, data, callback: IOnData, async = true) {
        let query = [];
        for (let key in data) {
            if (data.hasOwnProperty(key))
                query.push(encodeURIComponent(key) + '=' + encodeURIComponent(data[key]));
        }
        Ajax.send(url + (query.length ? '?' + query.join('&') : ''), callback, 'GET', null, async);
    }

    public static post(url: string, data, callback: IOnData, async = true) {
        let query = [];
        for (let key in data) {
            if (data.hasOwnProperty(key))
                query.push(encodeURIComponent(key) + '=' + encodeURIComponent(data[key]));
        }
        Ajax.send(url, callback, 'POST', query.join('&'), async);
    }

    protected static getXHR() {
        if (typeof XMLHttpRequest !== 'undefined') {
            return new XMLHttpRequest();
        }
    }
}

export class Service implements IService {
    public username: string;
    public url: string;

    get authenticated(): boolean {
        return this._authenticated;
    };
    protected _authenticated;

    public login(username?: string, password?: string): Promise<any> {
        if (username)
            this.username = username;
        return this.execute('Application', 'login', { username, password });
    };

    public logout(): Promise<any> {
        this._authenticated = false;
        return this.execute('Application', 'logout');
    };

    public execute(adapter: string, method: string, params?: any): Promise<IResponse> {
        if (typeof params === 'object')
            params = JSON.stringify(params);
        let data = {
            adapter,
            method,
            params: params || null
        };
        let promise = new Promise((resolve, reject) => {
            Ajax.post(this.url, data, (result) => {
                // cutting php raw output
                let raw = '';
                if (typeof result === 'string') {
                    if (result.indexOf('{"data":') >= 0) {
                        raw = result.substr(0, result.indexOf('{"data":'));
                        let s = result.substr(result.indexOf('{"data":'));
                        let res = Ajax.parseJSON(s);
                        result = {
                            data: res.data ? res.data : res,
                            error: res.error ? res.error : '' /*raw*/,
                            errorCallstack: res.errorCallstack ? res.errorCallstack : ''
                        };
                    }
                    else {
                        raw = result;
                        result = {
                            data: '',
                            error: 'Service error',
                            errorCallstack: ''
                        };
                    }
                }

                // handling response
                if ((result && result.error) || raw) {
                    let msg = result.error;
                    if (application.obj.config.debug && result.errorCallstack) {
                        msg += '<div style="font-weight: normal; font-size: 12px; /*color: rgba(0,0,0,0.8);*/">' + result.errorCallstack + '</div>';
                    }
                    if (application.obj.config.showServiceRawOutput && raw)
                        msg += '<div style="margin-top: 10px"><div style="margin-bottom: -10px; font-size: 16px">PHP:</div>' + raw + '</div>';
                    application.obj.showMessage(msg);
                    if (result && !result.error)
                        resolve(result);
                    else
                        reject(result);
                }
                else
                    resolve(result);
            });
        });
        return promise;
    };

    public getSessionInfo() {
        return this.execute('UserSession', 'getSessionInfo')
            .then((data) => {
                // this.login(); 
            });
    }
}
