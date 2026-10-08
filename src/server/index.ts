import {Agent, routeAgentRequest } from "agents";

export class ResearchAgent extends Agent<Env>{
    async onRequest(_request: Request){
        return Response.json({
            ok:true,
            instance: this.name,
            at: new Date().toISOString(),
        });
    }
}

export default {
    async fetch(request:Request, env: Env): Promise<Response>{
        return(
            (await routeAgentRequest(request,env)) ??
            new Response ("Not Found", {status:404})
        );
    },
}satisfies ExportedHandler<Env>;