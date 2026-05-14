import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import type { HeartbeatTracker, PeerHeartbeat } from "@/lib/resilience/heartbeat";

export type SocketHealth = "connected" | "reconnecting" | "disconnected";
export type OverallHealth = "good" | "degraded" | "bad";

export interface ConnectionHealth {
  socket: SocketHealth;
  socketAttempt: number;
  peers: Record<string, PeerHeartbeat>;
  overall: OverallHealth;
}

function classifyOverall(socket: SocketHealth, peers: Record<string, PeerHeartbeat>): OverallHealth {
  if (socket === "disconnected") return "bad";
  const states = Object.values(peers);
  if (socket === "reconnecting") return states.length === 0 ? "degraded" : "degraded";
  if (states.length === 0) return "good";
  const dead = states.filter((p) => p.status === "dead").length;
  const unhealthy = states.filter((p) => p.status === "unhealthy").length;
  const stale = states.filter((p) => p.status === "stale").length;
  if (dead > 0) return "bad";
  if (unhealthy > 0) return "bad";
  if (stale > states.length / 2) return "degraded";
  if (stale > 0) return "degraded";
  return "good";
}

export function useConnectionHealth(
  socket: Socket | null,
  heartbeat: HeartbeatTracker | null
): ConnectionHealth {
  const [socketState, setSocketState] = useState<SocketHealth>(socket?.connected ? "connected" : "disconnected");
  const [attempt, setAttempt] = useState(0);
  const [peers, setPeers] = useState<Record<string, PeerHeartbeat>>(() => heartbeat?.snapshot() ?? {});

  useEffect(() => {
    if (!socket) {
      setSocketState("disconnected");
      setAttempt(0);
      return;
    }
    setSocketState(socket.connected ? "connected" : "reconnecting");
    const onConnect = () => {
      setSocketState("connected");
      setAttempt(0);
    };
    const onDisconnect = () => {
      // socket.io fires this on transient drops; the manager's reconnect loop
      // will surface attempt counts via reconnect_attempt.
      setSocketState("reconnecting");
    };
    const onConnectError = () => {
      setSocketState((s) => (s === "connected" ? "reconnecting" : s));
    };
    const onAttempt = (n: number) => {
      setSocketState("reconnecting");
      setAttempt(n);
    };
    const onFailed = () => {
      setSocketState("disconnected");
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.io.on("reconnect_attempt", onAttempt);
    socket.io.on("reconnect_failed", onFailed);
    socket.io.on("reconnect", onConnect);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.io.off("reconnect_attempt", onAttempt);
      socket.io.off("reconnect_failed", onFailed);
      socket.io.off("reconnect", onConnect);
    };
  }, [socket]);

  useEffect(() => {
    if (!heartbeat) {
      setPeers({});
      return;
    }
    return heartbeat.subscribe(setPeers);
  }, [heartbeat]);

  return {
    socket: socketState,
    socketAttempt: attempt,
    peers,
    overall: classifyOverall(socketState, peers),
  };
}
