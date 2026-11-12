export class PilotError extends Error {
  constructor(message,status=400,code='invalid_request'){super(message);this.status=status;this.code=code;}
}
export const requireValue=(condition,message,status=400,code)=>{if(!condition)throw new PilotError(message,status,code);};

