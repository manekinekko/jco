/* eslint-disable no-unused-vars */

/**
 * @typedef {import("../../types/interfaces/wasi-sockets-network").Network} Network
 * @typedef {import("../../types/interfaces/wasi-sockets-network").IpSocketAddress} IpSocketAddress
 * @typedef {import("../../types/interfaces/wasi-sockets-tcp").TcpSocket} TcpSocket
 * @typedef {import("../../types/interfaces/wasi-sockets-tcp").InputStream} InputStream
 * @typedef {import("../../types/interfaces/wasi-sockets-tcp").OutputStream} OutputStream
 * @typedef {import("../../types/interfaces/wasi-sockets-tcp").IpAddressFamily} IpAddressFamily
 * @typedef {import("../../types/interfaces/wasi-io-poll-poll").Pollable} Pollable
 * @typedef {import("../../types/interfaces/wasi-sockets-tcp").ShutdownType} ShutdownType
 */

import { streams } from "../common/io.js";
const { InputStream, OutputStream } = streams;

import { assert } from "../common/assert.js";

// See: https://github.com/nodejs/node/blob/main/src/tcp_wrap.cc
const {
  TCP,
  TCPConnectWrap,
  constants: TCPConstants,
} = process.binding("tcp_wrap");
const { ShutdownWrap } = process.binding("stream_wrap");
import { isIP, Socket as NodeSocket } from "node:net";

import { serializeIpAddress, deserializeIpAddress } from "./socket-common.js";

const ShutdownType = {
  receive: "receive",
  send: "send",
  both: "both",
};

const SocketState = {
  Error: "Error",
  Connection: "Connection",
  Listener: "Listener",
};

// TODO: implement would-block exceptions
// TODO: implement concurrency-conflict exceptions
export class TcpSocketImpl {
  /** @type {TCP.TCPConstants.SERVER} */ #serverHandle = null;
  /** @type {TCP.TCPConstants.SOCKET} */ #clientHandle = null;
  /** @type {Network} */ network = null;

  #isBound = false;
  #socketOptions = {};
  #canReceive = true;
  #canSend = true;
  #ipv6Only = false;
  #state = "closed";
  #inProgress = false;
  #connections = 0;
  #keepAlive = false;
  #noDelay = false;
  #unicastHopLimit = 10;
  #acceptedClient = null;

  // See: https://github.com/torvalds/linux/blob/fe3cfe869d5e0453754cf2b4c75110276b5e8527/net/core/request_sock.c#L19-L31
  #backlog = 128;

  /**
   * @param {IpAddressFamily} addressFamily
   * @returns
   */
  constructor(addressFamily) {

    this.#socketOptions.family = addressFamily;

    this.#clientHandle = new TCP(TCPConstants.SOCKET);
    this.#serverHandle = new TCP(TCPConstants.SERVER);
    this._handle = this.#serverHandle;
    this._handle.onconnection = this.#handleConnection.bind(this);
    this._handle.onclose = this.#handleDisconnect.bind(this);
  }

  #handleConnection(err, newClientSocket) {
    console.log(`[tcp] on server connection`);

    if (err) {
      assert(true, "", err);
    }

    this.#acceptedClient = new NodeSocket({ handle: newClientSocket });
    this.#connections++;
    // reserved
    this.#acceptedClient.server = this.#serverHandle;
    this.#acceptedClient._server = this.#serverHandle;
    this.#acceptedClient._handle.onread = (nread, buffer) => {
      if (nread > 0) {
        // TODO: handle data received from the client
        const data = buffer.toString("utf8", 0, nread);
        console.log("accepted socket on read:", data);
      }
    };
  }

  #handleDisconnect(err) {
    console.log(`[tcp] on server disconnect`);
  }

  #onClientConnectComplete(err) {
    console.log(`[tcp] on client connect complete`);

    if (err) {
      assert(err === -99, "ephemeral-ports-exhausted");
      assert(err === -104, "connection-reset");
      assert(err === -110, "timeout");
      assert(err === -111, "connection-refused");
      assert(err === -113, "remote-unreachable");
      assert(err === -125, "operation-cancelled");

      throw new Error(err);
    }

    this.#state = "connected";
  }

  // TODO: is this needed?
  #handleAfterShutdown() {
    console.log(`[tcp] after shutdown socket`);
  }

  /**
   * @param {Network} network
   * @param {IpSocketAddress} localAddress
   * @returns {void}
   * @throws {invalid-argument} The `local-address` has the wrong address family. (EAFNOSUPPORT, EFAULT on Windows)
   * @throws {invalid-argument} `local-address` is not a unicast address. (EINVAL)
   * @throws {invalid-argument} `local-address` is an IPv4-mapped IPv6 address, but the socket has `ipv6-only` enabled. (EINVAL)
   * @throws {invalid-state} The socket is already bound. (EINVAL)
   */
  startBind(network, localAddress) {
    const address = serializeIpAddress(
      localAddress,
      this.#socketOptions.family
    );
    const ipFamily = `ipv${isIP(address)}`;

    console.log(
      `[tcp] start bind socket to ${address}:${localAddress.val.port}`
    );

    assert(this.#isBound, "invalid-state", "The socket is already bound");
    assert(
      this.#socketOptions.family.toLocaleLowerCase() !==
        ipFamily.toLocaleLowerCase(),
      "invalid-argument",
      "The `local-address` has the wrong address family"
    );

    // TODO: assert localAddress is not an unicast address
    assert(
      ipFamily.toLocaleLowerCase() === "ipv4" && this.ipv6Only(),
      "invalid-argument",
      "`local-address` is an IPv4-mapped IPv6 address, but the socket has `ipv6-only` enabled."
    );

    const { port } = localAddress.val;
    this.#socketOptions.localAddress = address;
    this.#socketOptions.localPort = port;
    this.network = network;
    this.#inProgress = true;
  }

  /**
   * @returns {void}
   * @throws {address-in-use} No ephemeral ports available. (EADDRINUSE, ENOBUFS on Windows)
   * @throws {address-in-use} Address is already in use. (EADDRINUSE)
   * @throws {address-not-bindable} `local-address` is not an address that the `network` can bind to. (EADDRNOTAVAIL)
   * @throws {not-in-progress} A `bind` operation is not in progress.
   * @throws {would-block} Can't finish the operation, it is still in progress. (EWOULDBLOCK, EAGAIN)
   **/
  finishBind() {
    console.log(`[tcp] finish bind socket`);

    assert(this.#inProgress === false, "not-in-progress");

    const { localAddress, localPort, family } = this.#socketOptions;
    assert(isIP(localAddress) === 0, "address-not-bindable");
    
    let err = null;
    if (family.toLocaleLowerCase() === "ipv4") {
      err = this.#serverHandle.bind(localAddress, localPort);
    } else if (family.toLocaleLowerCase() === "ipv6") {
      console.log(`[tcp] xxxx bind socket to ${localAddress}:${localPort}`);
      err = this.#serverHandle.bind6(localAddress, localPort);
    }

    if (err) {
      this.#serverHandle.close();
      assert(err === -22, "address-in-use");
      assert(err === -49, "address-not-bindable");
      assert(err === -99, "address-not-bindable"); // EADDRNOTAVAIL
      assert(true, "", err);
    }

    console.log(`[tcp] bound socket to ${localAddress}:${localPort}`);

    this.#isBound = true;
    this.#inProgress = false;
  }

  /**
   * @param {Network} network
   * @param {IpSocketAddress} remoteAddress
   * @returns {void}
   * @throws {invalid-argument} The `remote-address` has the wrong address family. (EAFNOSUPPORT)
   * @throws {invalid-argument} `remote-address` is not a unicast address. (EINVAL, ENETUNREACH on Linux, EAFNOSUPPORT on MacOS)
   * @throws {invalid-argument} `remote-address` is an IPv4-mapped IPv6 address, but the socket has `ipv6-only` enabled. (EINVAL, EADDRNOTAVAIL on Illumos)
   * @throws {invalid-argument} `remote-address` is a non-IPv4-mapped IPv6 address, but the socket was bound to a specific IPv4-mapped IPv6 address. (or vice versa)
   * @throws {invalid-argument} The IP address in `remote-address` is set to INADDR_ANY (`0.0.0.0` / `::`). (EADDRNOTAVAIL on Windows)
   * @throws {invalid-argument} The port in `remote-address` is set to 0. (EADDRNOTAVAIL on Windows)
   * @throws {invalid-argument} The socket is already attached to a different network. The `network` passed to `connect` must be identical to the one passed to `bind`.
   * @throws {invalid-state} The socket is already in the Connection state. (EISCONN)
   * @throws {invalid-state} The socket is already in the Listener state. (EOPNOTSUPP, EINVAL on Windows)
   */
  startConnect(network, remoteAddress) {
    console.log(
      `[tcp] start connect socket to ${remoteAddress.val.address}:${remoteAddress.val.port}`
    );

    assert(
      this.network !== null && this.network.id !== network.id,
      "already-attached"
    );
    assert(this.#state === "connected", "already-connected");
    assert(this.#state === "connection", "already-listening");
    assert(this.#inProgress, "concurrency-conflict");

    const host = serializeIpAddress(remoteAddress, this.#socketOptions.family);
    const ipFamily = `ipv${isIP(host)}`;

    assert(ipFamily.toLocaleLowerCase() === "ipv0", "invalid-remote-address");
    assert(
      this.#socketOptions.family.toLocaleLowerCase() !==
        ipFamily.toLocaleLowerCase(),
      "address-family-mismatch"
    );

    this.network = network;
    this.#socketOptions.remoteAddress = host;
    this.#socketOptions.remotePort = remoteAddress.val.port;

    this.#inProgress = true;
  }

  /**
   * @returns {Array<InputStream, OutputStream>}
   * @throws {timeout} Connection timed out. (ETIMEDOUT)
   * @throws {connection-refused} The connection was forcefully rejected. (ECONNREFUSED)
   * @throws {connection-reset} The connection was reset. (ECONNRESET)
   * @throws {connection-aborted} The connection was aborted. (ECONNABORTED)
   * @throws {remote-unreachable} The remote address is not reachable. (EHOSTUNREACH, EHOSTDOWN, ENETUNREACH, ENETDOWN)
   * @throws {address-in-use} Tried to perform an implicit bind, but there were no ephemeral ports available. (EADDRINUSE, EADDRNOTAVAIL on Linux, EAGAIN on BSD)
   * @throws {not-in-progress} A `connect` operation is not in progress.
   * @throws {would-block} Can't finish the operation, it is still in progress. (EWOULDBLOCK, EAGAIN)
   */
  finishConnect() {
    console.log(`[tcp] finish connect socket`);

    assert(this.#inProgress === false, "not-in-progress");

    const { localAddress, localPort, remoteAddress, remotePort, family } =
      this.#socketOptions;
    const connectReq = new TCPConnectWrap();

    let err = null;
    if (family.toLocaleLowerCase() === "ipv4") {
      err = this.#clientHandle.connect(connectReq, remoteAddress, remotePort);
    } else if (family.toLocaleLowerCase() === "ipv6") {
      err = this.#clientHandle.connect6(connectReq, remoteAddress, remotePort);
    }

    if (err) {
      console.error(`[tcp] connect error on socket: ${err}`);
      this.#state = SocketState.Error;
    }

    connectReq.oncomplete = this.#onClientConnectComplete.bind(this);
    connectReq.address = remoteAddress;
    connectReq.port = remotePort;
    connectReq.localAddress = localAddress;
    connectReq.localPort = localPort;

    this.#clientHandle.onread = (buffer) => {
      // TODO: handle data received from the server
    };

    this.#clientHandle.readStart();
    this.#inProgress = false;

    // TODO: return InputStream and OutputStream
    return [];
  }

  /**
   * @returns {void}
   * @throws {invalid-state} The socket is not bound to any local address. (EDESTADDRREQ)
   * @throws {invalid-state} The socket is already in the Connection state. (EISCONN, EINVAL on BSD)
   * @throws {invalid-state} The socket is already in the Listener state.
   */
  startListen() {
    console.log(
      `[tcp] start listen socket on ${this.#socketOptions.localAddress}:${
        this.#socketOptions.localPort
      }`
    );

    assert(this.#isBound === false, "invalid-state");
    assert(this.#state === SocketState.Connection, "invalid-state");
    assert(this.#state === SocketState.Listener, "invalid-state");

    this.#inProgress = true;
  }

  /**
   * @returns {void}
   * @throws {address-in-use} Tried to perform an implicit bind, but there were no ephemeral ports available. (EADDRINUSE)
   * @throws {not-in-progress} A `listen` operation is not in progress.
   * @throws {would-block} Can't finish the operation, it is still in progress. (EWOULDBLOCK, EAGAIN)
   */
  finishListen() {
    console.log(`[tcp] finish listen socket (backlog: ${this.#backlog})`);

    assert(this.#inProgress === false, "not-in-progress");

    const err = this.#serverHandle.listen(this.#backlog);
    if (err) {
      console.error(`[tcp] listen error on socket: ${err}`);
      this.#serverHandle.close();
      throw new Error(err);
    }

    this.#inProgress = false;
  }

  /**
   * @returns {Array<TcpSocket, InputStream, OutputStream>}
   * @throws {invalid-state} Socket is not in the Listener state. (EINVAL)
   * @throws {would-block} No pending connections at the moment. (EWOULDBLOCK, EAGAIN)
   * @throws {connection-aborted} An incoming connection was pending, but was terminated by the client before this listener could accept it. (ECONNABORTED)
   * @throws {new-socket-limit} The new socket resource could not be created because of a system limit. (EMFILE, ENFILE)
   */
  accept() {
    // uv_accept is automatically called by uv_listen when a new connection is received.

    const _this = this;
    const outgoingStream = new OutputStream({
      write(bytes) {
        _this.#acceptedClient.write(bytes);
      },
    });
    const ingoingStream = new InputStream({
      read(len) {
        console.log(`[tcp] read socket`);
        return _this.#acceptedClient.read(len);
      },
    })

    return [this.#acceptedClient, ingoingStream, outgoingStream];
  }

  /**
   * @returns {IpSocketAddress}
   * @throws {invalid-state} The socket is not bound to any local address.
   */
  localAddress() {
    console.log(`[tcp] local address socket`);

    assert(this.#isBound === false, "invalid-state");

    const { localAddress, localPort, family } = this.#socketOptions;
    return {
      tag: family,
      val: {
        address: deserializeIpAddress(localAddress, family),
        port: localPort,
      },
    };
  }

  /**
   * @returns {IpSocketAddress}
   * @throws {invalid-state} The socket is not connected to a remote address. (ENOTCONN)
   */
  remoteAddress() {
    console.log(`[tcp] remote address socket`);

    assert(this.#state !== SocketState.Connection, "invalid-state");

    return this.#socketOptions.remoteAddress;
  }

  /**
   * @returns {IpAddressFamily}
   */
  addressFamily() {
    console.log(`[tcp] address family socket`);

    return this.#socketOptions.family;
  }

  /**
   * @returns {boolean}
   * @throws {not-supported} (get/set) `this` socket is an IPv4 socket.
   */
  ipv6Only() {
    console.log(`[tcp] ipv6 only socket`);

    return this.#ipv6Only;
  }

  /**
   * @param {boolean} value
   * @returns {void}
   * @throws {invalid-state} (set) The socket is already bound.
   * @throws {invalid-state} (get/set) `this` socket is an IPv4 socket.
   * @throws {not-supported} (set) Host does not support dual-stack sockets. (Implementations are not required to.)
   */
  setIpv6Only(value) {
    console.log(`[tcp] set ipv6 only socket to ${value}`);

    this.#ipv6Only = value;
  }

  /**
   * @param {bigint} value
   * @returns {void}
   * @throws {not-supported} (set) The platform does not support changing the backlog size after the initial listen.
   * @throws {invalid-state} (set) The socket is already in the Connection state.
   */
  setListenBacklogSize(value) {
    console.log(`[tcp] set listen backlog size socket to ${value}`);

    this.#backlog = value;
  }

  /**
   * @returns {boolean}
   */
  keepAlive() {
    console.log(`[tcp] keep alive socket`);

    this.#keepAlive;
  }

  /**
   * @param {boolean} value
   * @returns {void}
   */
  setKeepAlive(value) {
    console.log(`[tcp] set keep alive socket to ${value}`);

    this.#keepAlive = value;
    this.#clientHandle.setKeepAlive(value);
  }

  /**
   * @returns {boolean}
   */
  noDelay() {
    console.log(`[tcp] no delay socket`);

    return this.#noDelay;
  }

  /**
   * @param {boolean} value
   * @returns {void}
   * @throws {concurrency-conflict} (set) A `bind`, `connect` or `listen` operation is already in progress. (EALREADY)
   */
  setNoDelay(value) {
    console.log(`[tcp] set no delay socket to ${value}`);

    this.#noDelay = value;
    this.#clientHandle.setNoDelay(value);
  }

  /**
   * @returns {number}
   */
  unicastHopLimit() {
    console.log(`[tcp] unicast hop limit socket`);

    return this.#unicastHopLimit;
  }

  /**
   * @param {number} value
   * @returns {void}
   * @throws {invalid-argument} (set) The TTL value must be 1 or higher.
   * @throws {invalid-state} (set) The socket is already in the Connection state.
   * @throws {invalid-state} (set) The socket is already in the Listener state.
   */
  setUnicastHopLimit(value) {
    console.log(`[tcp] set unicast hop limit socket to ${value}`);

    this.#unicastHopLimit = value;
  }

  /**
   * @returns {bigint}
   */
  receiveBufferSize() {
    console.log(`[tcp] receive buffer size socket`);
    throw new Error("not implemented");
  }

  /**
   * @param {number} value
   * @returns {void}
   * @throws {invalid-state} (set) The socket is already in the Connection state.
   * @throws {invalid-state} (set) The socket is already in the Listener state.
   */
  setReceiveBufferSize(value) {
    console.log(`[tcp] set receive buffer size socket to ${value}`);
    throw new Error("not implemented");
  }

  /**
   * @returns {bigint}
   */
  sendBufferSize() {
    console.log(`[tcp] send buffer size socket`);
    throw new Error("not implemented");
  }

  /**
   * @param {bigint} value
   * @returns {void}
   * @throws {invalid-state} (set) The socket is already in the Connection state.
   * @throws {invalid-state} (set) The socket is already in the Listener state.
   */
  setSendBufferSize(value) {
    console.log(`[tcp] set send buffer size socket to ${value}`);
    throw new Error("not implemented");
  }

  /**
   * @returns {Pollable}
   */
  subscribe() {
    console.log(`[tcp] subscribe socket`);
    throw new Error("not implemented");
  }

  /**
   * @param {ShutdownType} shutdownType
   * @returns {void}
   * @throws {invalid-state} The socket is not in the Connection state. (ENOTCONN)
   */
  shutdown(shutdownType) {
    console.log(`[tcp] shutdown socket with type ${shutdownType}`);

    // TODO: figure out how to handle shutdownTypes
    if (shutdownType === ShutdownType.receive) {
      this.#canReceive = false;
    } else if (shutdownType === ShutdownType.send) {
      this.#canSend = false;
    } else if (shutdownType === ShutdownType.both) {
      this.#canReceive = false;
      this.#canSend = false;
    }

    const req = new ShutdownWrap();
    req.oncomplete = this.#handleAfterShutdown.bind(this);
    req.handle = this._handle;
    req.callback = () => {
      console.log(`[tcp] shutdown callback`);
    };
    const err = this._handle.shutdown(req);

    assert(err === 1, "invalid-state");
  }

  server() {
    return this.#serverHandle;
  }
  client() {
    return this.#clientHandle;
  }
}
