/**
 * Numeric error codes carried by MygramDB `ERROR` frames (MygramDB v1.10+).
 *
 * A v1.10 server prefixes every `ERROR` frame payload with a decimal code
 * (`ERROR 4007 Table not found`), so a client can branch on the code instead of
 * matching message text. Older servers send an untyped `ERROR <message>` frame;
 * {@link ../response-parser.parseErrorFrame} decodes both shapes and leaves
 * {@link ../errors.ServerError.code} undefined for the untyped form.
 *
 * The values mirror the server's `mygram::utils::ErrorCode` enumeration. Codes
 * are grouped by range: general (0-999), configuration (1000-1999), MySQL
 * (2000-2999), query parsing (3000-3999), index/search (4000-4999), storage
 * (5000-5999), network/server (6000-6999), client (7000-7999), and cache
 * (8000-8999).
 */
export const ErrorCode = {
  // General (0-999)
  Unknown: 1,
  InvalidArgument: 2,
  OutOfRange: 3,
  NotImplemented: 4,
  InternalError: 5,
  IOError: 6,
  /** Administrative command issued without a successful `AUTH` (MygramDB v1.10+). */
  PermissionDenied: 7,
  NotFound: 8,
  AlreadyExists: 9,
  Timeout: 10,
  Cancelled: 11,

  // Configuration (1000-1999)
  ConfigFileNotFound: 1000,
  ConfigParseError: 1001,
  ConfigValidationError: 1002,
  ConfigMissingRequired: 1003,
  ConfigInvalidValue: 1004,
  ConfigSchemaError: 1005,
  ConfigYamlError: 1006,
  ConfigJsonError: 1007,

  // MySQL / replication (2000-2999)
  MySQLConnectionFailed: 2000,
  MySQLQueryFailed: 2001,
  MySQLDisconnected: 2002,
  MySQLAuthFailed: 2003,
  MySQLTimeout: 2004,
  MySQLInvalidGTID: 2005,
  MySQLGTIDNotEnabled: 2006,
  MySQLReplicationError: 2007,
  MySQLBinlogError: 2008,
  MySQLTableNotFound: 2009,
  MySQLColumnNotFound: 2010,
  MySQLDuplicateColumn: 2011,
  MySQLInvalidSchema: 2012,
  MySQLFieldTruncated: 2013,
  MySQLInvalidMetadata: 2014,
  MySQLUnsupportedType: 2015,
  MySQLBinlogChecksumMismatch: 2016,
  /**
   * Replication stopped on a binlog event this server build cannot decode
   * (MygramDB v1.10+). Recovery is a `SYNC` of the table that matters followed
   * by a `SYNC` of every other replicated table.
   */
  MySQLUndecodableBinlogEvent: 2017,
  MariaDBInvalidGTID: 2020,
  MariaDBProtocolError: 2021,
  MariaDBUnsupportedVersion: 2022,

  // Query parsing (3000-3999)
  QuerySyntaxError: 3000,
  QueryInvalidToken: 3001,
  QueryUnexpectedToken: 3002,
  QueryMissingOperand: 3003,
  QueryInvalidOperator: 3004,
  QueryTooLong: 3005,
  QueryInvalidFilter: 3006,
  QueryInvalidSort: 3007,
  QueryInvalidLimit: 3008,
  QueryInvalidOffset: 3009,
  QueryExpressionParseError: 3010,
  QueryASTBuildError: 3011,

  // Index / search (4000-4999)
  IndexNotFound: 4000,
  IndexCorrupted: 4001,
  IndexSerializationFailed: 4002,
  IndexDeserializationFailed: 4003,
  IndexDocumentNotFound: 4004,
  IndexInvalidDocID: 4005,
  IndexFull: 4006,
  TableNotFound: 4007,
  CatalogNotInitialized: 4008,
  SyncTableNotFound: 4010,
  SyncAlreadyInProgress: 4011,
  SyncMemoryCritical: 4012,
  SyncThreadCreationFailed: 4013,
  SyncManagerNull: 4014,

  // Storage / dump (5000-5999)
  StorageFileNotFound: 5000,
  StorageReadError: 5001,
  StorageWriteError: 5002,
  StorageCorrupted: 5003,
  StorageCRCMismatch: 5004,
  StorageVersionMismatch: 5005,
  StorageCompressionFailed: 5006,
  StorageDecompressionFailed: 5007,
  StorageInvalidFormat: 5008,
  StorageSnapshotBuildFailed: 5009,
  StorageDocIdExhausted: 5010,
  StorageDumpReadError: 5011,
  StorageDumpWriteError: 5012,

  // Network / server (6000-6999)
  NetworkBindFailed: 6000,
  NetworkListenFailed: 6001,
  NetworkAcceptFailed: 6002,
  NetworkConnectionRefused: 6003,
  NetworkConnectionClosed: 6004,
  NetworkSendFailed: 6005,
  NetworkReceiveFailed: 6006,
  NetworkInvalidRequest: 6007,
  NetworkProtocolError: 6008,
  NetworkServerNotStarted: 6010,
  NetworkAlreadyRunning: 6011,
  NetworkSocketCreationFailed: 6012,
  NetworkInvalidBindAddress: 6013,
  NetworkUnixSocketPathTooLong: 6014,
  NetworkUnixSocketStale: 6015,
  NetworkReactorUnsupported: 6016,
  NetworkReactorInitFailed: 6017,
  NetworkReactorRegisterFailed: 6018,
  NetworkReactorModifyFailed: 6019,
  NetworkReactorRemoveFailed: 6020,
  NetworkReactorPollFailed: 6021,
  NetworkReactorAlreadyOpen: 6023,
  NetworkNullDependency: 6024,
  NetworkAcceptorNoHandler: 6025,
  ServerInitMissingDependency: 6026,
  /** Server is shutting down and rejects new long-running operations. */
  ServerShuttingDown: 6027,
  /** Server is temporarily unavailable while it loads a dump (MygramDB v1.10+). */
  ServerLoading: 6028,
  /** Server is not ready to serve the requested operation (MygramDB v1.10+). */
  ServerNotReady: 6029,
  /** Rate limit hit, or a long operation holds the table (MygramDB v1.10+). */
  ServerBusy: 6030,

  // Client (7000-7999)
  ClientNotConnected: 7000,
  ClientConnectionFailed: 7001,
  ClientSendFailed: 7002,
  ClientReceiveFailed: 7003,
  ClientInvalidResponse: 7004,
  ClientTimeout: 7005,
  ClientAlreadyConnected: 7006,
  ClientCommandFailed: 7007,
  ClientConnectionClosed: 7008,
  ClientInvalidArgument: 7009,
  ClientServerError: 7010,
  ClientProtocolError: 7011,
  ClientExpressionParseError: 7012,

  // Cache (8000-8999)
  CacheMiss: 8000,
  CacheDisabled: 8001,
  CacheCompressionFailed: 8002,
  CacheDecompressionFailed: 8003,
  CacheWorkerStartFailed: 8004
} as const;

/**
 * Any numeric value from {@link ErrorCode}.
 *
 * A server may introduce codes newer than this client, so
 * {@link ../errors.ServerError.code} is typed as `number` rather than this
 * union — use this type for values the caller supplies.
 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Codes that describe a transient server-side condition: the same command has
 * a reasonable chance of succeeding when retried after a short backoff.
 *
 * Mirrors the retry classification the MygramDB CLI applies (MygramDB v1.10+),
 * which replaced substring matching on error messages.
 */
const RETRYABLE_ERROR_CODES: ReadonlySet<number> = new Set<number>([
  ErrorCode.Timeout,
  ErrorCode.MySQLTimeout,
  ErrorCode.ServerLoading,
  ErrorCode.ServerNotReady,
  ErrorCode.ServerBusy
]);

/**
 * Codes that mean the connection itself is gone, so a retry requires
 * reconnecting (and re-authenticating) first rather than resending.
 */
const CONNECTION_LOST_ERROR_CODES: ReadonlySet<number> = new Set<number>([
  ErrorCode.NetworkConnectionClosed,
  ErrorCode.ClientConnectionClosed,
  ErrorCode.ClientNotConnected,
  ErrorCode.NetworkConnectionRefused
]);

/**
 * Whether a server error code describes a transient condition worth retrying.
 *
 * @param {number | undefined} code - Code from {@link ../errors.ServerError.code}
 * @returns {boolean} True when the command may be retried after a backoff
 *
 * @example
 * ```typescript
 * try {
 *   await client.search('articles', 'hello');
 * } catch (error) {
 *   if (error instanceof ServerError && isRetryableErrorCode(error.code)) {
 *     // back off and retry
 *   }
 * }
 * ```
 */
export function isRetryableErrorCode(code: number | undefined): boolean {
  return code !== undefined && RETRYABLE_ERROR_CODES.has(code);
}

/**
 * Whether a server error code means the connection was lost and must be
 * re-established before the command can be sent again.
 *
 * @param {number | undefined} code - Code from {@link ../errors.ServerError.code}
 * @returns {boolean} True when reconnecting is required
 */
export function isConnectionLostErrorCode(code: number | undefined): boolean {
  return code !== undefined && CONNECTION_LOST_ERROR_CODES.has(code);
}

/**
 * Whether a server error code means the command was refused for lack of
 * administrative credentials (MygramDB v1.10+).
 *
 * A v1.10 server gates administrative commands behind `AUTH`. Set
 * {@link ../types.ClientConfig.adminToken} so the client authenticates
 * automatically, or call `authenticate()` explicitly.
 *
 * @param {number | undefined} code - Code from {@link ../errors.ServerError.code}
 * @returns {boolean} True when the command requires authentication
 */
export function isAuthRequiredErrorCode(code: number | undefined): boolean {
  return code === ErrorCode.PermissionDenied;
}
