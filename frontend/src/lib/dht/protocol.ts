// Kademlia wire messages. Carried in JSON envelopes inside the same chat
// DataChannel that drive uses, namespaced under op: 'dht:*'.
//
// Each request carries an `rid` (request id) the responder echoes so the
// caller can match concurrent requests. Lookups in iterativeFindValue() use
// this to demultiplex parallel α-fanout queries.

export type DhtMessage =
  | { op: "dht:ping"; rid: string; fromIdHex: string }
  | { op: "dht:pong"; rid: string; fromIdHex: string }
  | { op: "dht:find-node"; rid: string; fromIdHex: string; targetHex: string }
  | {
      op: "dht:find-node-response";
      rid: string;
      fromIdHex: string;
      contacts: Array<{ idHex: string; handle: string }>;
    }
  | { op: "dht:find-value"; rid: string; fromIdHex: string; keyHex: string }
  | {
      op: "dht:find-value-response";
      rid: string;
      fromIdHex: string;
      // Either we have the value (`valueB64` set) or we don't and return
      // the closest contacts we know of.
      valueB64: string | null;
      contacts: Array<{ idHex: string; handle: string }>;
    }
  | { op: "dht:store"; rid: string; fromIdHex: string; keyHex: string; valueB64: string }
  | { op: "dht:store-ack"; rid: string; fromIdHex: string; ok: boolean };

export interface DhtTransport {
  send: (handle: string, msg: DhtMessage) => boolean;
  subscribe: (handler: (fromHandle: string, msg: DhtMessage) => void) => () => void;
}
