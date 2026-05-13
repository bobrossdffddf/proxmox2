declare module "react-vnc" {
  import { ForwardRefExoticComponent, RefAttributes } from "react";

  interface VncScreenProps {
    url: string;
    style?: React.CSSProperties;
    className?: string;
    scaleViewport?: boolean;
    viewOnly?: boolean;
    focusOnClick?: boolean;
    clipViewport?: boolean;
    dragViewport?: boolean;
    resizeSession?: boolean;
    showDotCursor?: boolean;
    background?: string;
    qualityLevel?: number;
    compressionLevel?: number;
    autoConnect?: boolean;
    retryDuration?: number;
    debug?: boolean;
    onConnect?: (rfb?: any) => void;
    onDisconnect?: (rfb?: any) => void;
    onCredentialsRequired?: (rfb?: any) => void;
    onSecurityFailure?: (e?: any) => void;
    onClipboard?: (e?: any) => void;
    onBell?: () => void;
    onDesktopName?: (e?: any) => void;
    onCapabilities?: (e?: any) => void;
    ref?: any;
  }

  export const VncScreen: ForwardRefExoticComponent<VncScreenProps & RefAttributes<any>>;
}
