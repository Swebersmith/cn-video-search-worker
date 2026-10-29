import type {Server} from 'node:http';
export function createOfficialGateway(token:string,fetcher?:(url:string,init?:RequestInit)=>Promise<Response>):Server;
