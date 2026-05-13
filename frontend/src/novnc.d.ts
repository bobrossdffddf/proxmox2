declare module "@novnc/novnc/core/rfb" {
  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: any);
    scaleViewport: boolean;
    resizeSession: boolean;
    addEventListener(event: string, handler: (e: any) => void): void;
    disconnect(): void;
    sendCredentials(credentials: any): void;
  }
}
