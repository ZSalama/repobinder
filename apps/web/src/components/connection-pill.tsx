import { Server, Wifi, WifiOff } from "lucide-react";

import { StatusPill } from "@/components/status-display";
import { SocketState } from "@/types";

export function ConnectionPill(props: { socketState: SocketState; remoteEnabled: boolean }): JSX.Element {
  if (props.remoteEnabled) {
    return <StatusPill icon={<Wifi size={15} />} tone="warning" label="Remote" />;
  }

  return props.socketState === "open" ? (
    <StatusPill icon={<Server size={15} />} tone="success" label="Live" />
  ) : (
    <StatusPill icon={<WifiOff size={15} />} tone="danger" label="Offline" />
  );
}
