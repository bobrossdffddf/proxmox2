/**
 * Translate VMware's guest OS identifiers into the things WCTARange needs to
 * know: the Proxmox `ostype`, which console protocol the tile should use, and
 * which icon to draw.
 *
 * VMware ids are stable and well-documented, but oddly named — Windows 10 is
 * `windows9`, and Server 2022 is `windows2019srvNext`. The table below is
 * ordered specific-to-general and the first regex that matches wins.
 */

export type OsFamily = "windows" | "linux" | "other";
export type TileIcon = "windows" | "server" | "linux" | "network" | "generic";

export interface OsProfile {
  /** Proxmox `ostype` config value. */
  ostype: string;
  family: OsFamily;
  icon: TileIcon;
  /** Human label for the wizard's summary. */
  label: string;
  protocol: "rdp" | "vnc";
  port: number;
  /** Sensible default account name for the tile's pre-filled credentials. */
  defaultUsername: string;
}

const WINDOWS_DESKTOP = (ostype: string, label: string): OsProfile => ({
  ostype,
  family: "windows",
  icon: "windows",
  label,
  protocol: "rdp",
  port: 3389,
  defaultUsername: "Administrator",
});

const WINDOWS_SERVER = (ostype: string, label: string): OsProfile => ({
  ostype,
  family: "windows",
  icon: "server",
  label,
  protocol: "rdp",
  port: 3389,
  defaultUsername: "Administrator",
});

const LINUX = (label: string): OsProfile => ({
  ostype: "l26",
  family: "linux",
  icon: "linux",
  label,
  protocol: "vnc",
  port: 5900,
  defaultUsername: "cyber",
});

export const UNKNOWN_OS: OsProfile = {
  ostype: "other",
  family: "other",
  icon: "generic",
  label: "Unknown",
  protocol: "vnc",
  port: 5900,
  defaultUsername: "root",
};

/**
 * Patterns are matched against a *normalised* hint with spaces, dashes and
 * underscores removed, so `windows11-64`, `Windows 11 Pro` and `windows_11` all
 * reduce to the same thing and one pattern covers them.
 */
const TABLE: Array<{ match: RegExp; profile: OsProfile }> = [
  // Windows Server. `windows2019srvNext` is VMware's id for Server 2022, and
  // Proxmox groups 2022/2025 under the win11 ostype.
  { match: /windows2025|2019srvnext|windows2022|server20(22|25)/i, profile: WINDOWS_SERVER("win11", "Windows Server 2022/2025") },
  { match: /windows2019|windows2016|server20(16|19)/i, profile: WINDOWS_SERVER("win10", "Windows Server 2016/2019") },
  { match: /windows2012|windows8srv|server2012/i, profile: WINDOWS_SERVER("win8", "Windows Server 2012") },
  { match: /windows7srv|windows2008|longhorn|server2008/i, profile: WINDOWS_SERVER("w2k8", "Windows Server 2008") },
  { match: /winnetstandard|winnetenterprise|windows2003|server2003/i, profile: WINDOWS_SERVER("w2k3", "Windows Server 2003") },
  // Only a *Windows* server: "ubuntuserver2204" must not land here.
  { match: /win\w*(srv|server)/i, profile: WINDOWS_SERVER("win10", "Windows Server") },

  // Windows desktop.
  { match: /windows11|win11/i, profile: WINDOWS_DESKTOP("win11", "Windows 11") },
  { match: /windows9|windows10|win10/i, profile: WINDOWS_DESKTOP("win10", "Windows 10") },
  { match: /windows8|win8/i, profile: WINDOWS_DESKTOP("win8", "Windows 8") },
  { match: /windows7|win7/i, profile: WINDOWS_DESKTOP("win7", "Windows 7") },
  { match: /winvista/i, profile: WINDOWS_DESKTOP("wvista", "Windows Vista") },
  { match: /winxp/i, profile: WINDOWS_DESKTOP("wxp", "Windows XP") },
  { match: /win2000|windows2000/i, profile: WINDOWS_DESKTOP("w2k", "Windows 2000") },

  // Linux.
  { match: /ubuntu/i, profile: LINUX("Ubuntu") },
  { match: /debian/i, profile: LINUX("Debian") },
  { match: /rhel|redhat|centos|rocky|alma|fedora|oracle/i, profile: LINUX("RHEL family") },
  { match: /suse|sles/i, profile: LINUX("SUSE") },
  { match: /arch|kali|mint|linux/i, profile: LINUX("Linux") },

  // Catch-all for anything Windows-shaped we didn't name explicitly.
  { match: /windows|win/i, profile: WINDOWS_DESKTOP("win10", "Windows") },
];

/**
 * Best guess from whatever strings the source gave us — a VMX `guestOS` value,
 * an OVF `vmw:osType`, a product name, the VM's own name. Later hints only
 * apply if the earlier ones didn't match anything.
 */
export function detectOs(...hints: Array<string | undefined | null>): OsProfile {
  for (const hint of hints) {
    if (!hint) continue;
    const normalized = hint.toLowerCase().replace(/[\s_-]+/g, "");
    for (const row of TABLE) {
      if (row.match.test(normalized)) return row.profile;
    }
  }
  return UNKNOWN_OS;
}

/** Windows guests need a bigger floor to be usable over RDP than Linux ones. */
export function minimumMemoryMb(family: OsFamily): number {
  return family === "windows" ? 4096 : 2048;
}
