/**
 * Node.js N-API binding for MygramDB C++ client
 *
 * This file provides the N-API wrapper around the MygramDB C API,
 * exposing high-performance native bindings to JavaScript.
 */

#include <node_api.h>
#include <string>
#include <cstring>
#include <cstdlib>
#include <vector>
#include "../include/mygramclient_c.h"
#include "../include/search_expression.h"

#define NAPI_CALL(env, call)                                      \
  do {                                                            \
    napi_status status = (call);                                  \
    if (status != napi_ok) {                                      \
      const napi_extended_error_info* error_info = nullptr;       \
      napi_get_last_error_info((env), &error_info);               \
      const char* err_message = error_info->error_message;        \
      bool is_pending;                                            \
      napi_is_exception_pending((env), &is_pending);              \
      if (!is_pending) {                                          \
        const char* message = (err_message == nullptr)            \
            ? "empty error message"                               \
            : err_message;                                        \
        napi_throw_error((env), nullptr, message);                \
      }                                                           \
      return nullptr;                                             \
    }                                                             \
  } while(0)

// Helper to throw error
static void ThrowError(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
}

/**
 * Create new MygramDB client
 *
 * @param {Object} config - Configuration object
 * @param {string} config.host - Server hostname
 * @param {number} config.port - Server port
 * @param {number} config.timeout - Connection timeout in milliseconds
 * @returns {External} Client handle
 */
static napi_value CreateClient(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));

  if (argc < 1) {
    ThrowError(env, "Expected config object");
    return nullptr;
  }

  // Parse config object
  napi_value config = args[0];
  napi_valuetype valuetype;
  NAPI_CALL(env, napi_typeof(env, config, &valuetype));

  if (valuetype != napi_object) {
    ThrowError(env, "Config must be an object");
    return nullptr;
  }

  // Extract host
  char host[256] = "127.0.0.1";
  napi_value host_val;
  bool has_host;
  NAPI_CALL(env, napi_has_named_property(env, config, "host", &has_host));
  if (has_host) {
    NAPI_CALL(env, napi_get_named_property(env, config, "host", &host_val));
    size_t host_len;
    NAPI_CALL(env, napi_get_value_string_utf8(env, host_val, host, sizeof(host), &host_len));
  }

  // Extract port
  int port = 11016;
  napi_value port_val;
  bool has_port;
  NAPI_CALL(env, napi_has_named_property(env, config, "port", &has_port));
  if (has_port) {
    NAPI_CALL(env, napi_get_named_property(env, config, "port", &port_val));
    NAPI_CALL(env, napi_get_value_int32(env, port_val, &port));
  }

  // Extract timeout
  int timeout = 5000;
  napi_value timeout_val;
  bool has_timeout;
  NAPI_CALL(env, napi_has_named_property(env, config, "timeout", &has_timeout));
  if (has_timeout) {
    NAPI_CALL(env, napi_get_named_property(env, config, "timeout", &timeout_val));
    NAPI_CALL(env, napi_get_value_int32(env, timeout_val, &timeout));
  }

  // Create client configuration
  MygramClientConfig_C config_c;
  config_c.host = host;
  config_c.port = static_cast<uint16_t>(port);
  config_c.timeout_ms = static_cast<uint32_t>(timeout);
  config_c.recv_buffer_size = 65536;

  // Create client
  MygramClient_C* client = mygramclient_create(&config_c);
  if (client == nullptr) {
    ThrowError(env, "Failed to create client");
    return nullptr;
  }

  // Wrap client handle
  napi_value result;
  NAPI_CALL(env, napi_create_external(env, client, nullptr, nullptr, &result));
  return result;
}

/**
 * Connect to MygramDB server
 *
 * @param {External} client - Client handle
 * @returns {boolean} True if connected successfully
 */
static napi_value Connect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));

  if (argc < 1) {
    ThrowError(env, "Expected client handle");
    return nullptr;
  }

  // Extract client handle
  MygramClient_C* client;
  NAPI_CALL(env, napi_get_value_external(env, args[0], reinterpret_cast<void**>(&client)));

  // Connect
  int result = mygramclient_connect(client);

  napi_value ret;
  NAPI_CALL(env, napi_get_boolean(env, result == 0, &ret));
  return ret;
}

/**
 * Disconnect from server
 *
 * @param {External} client - Client handle
 */
static napi_value Disconnect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));

  if (argc < 1) {
    ThrowError(env, "Expected client handle");
    return nullptr;
  }

  MygramClient_C* client;
  NAPI_CALL(env, napi_get_value_external(env, args[0], reinterpret_cast<void**>(&client)));

  mygramclient_disconnect(client);

  napi_value result;
  NAPI_CALL(env, napi_get_undefined(env, &result));
  return result;
}

/**
 * Destroy client and free resources
 *
 * @param {External} client - Client handle
 */
static napi_value DestroyClient(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));

  if (argc < 1) {
    ThrowError(env, "Expected client handle");
    return nullptr;
  }

  MygramClient_C* client;
  NAPI_CALL(env, napi_get_value_external(env, args[0], reinterpret_cast<void**>(&client)));

  mygramclient_destroy(client);

  napi_value result;
  NAPI_CALL(env, napi_get_undefined(env, &result));
  return result;
}

/**
 * Check if connected to server
 *
 * @param {External} client - Client handle
 * @returns {boolean} True if connected
 */
static napi_value IsConnected(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));

  if (argc < 1) {
    ThrowError(env, "Expected client handle");
    return nullptr;
  }

  MygramClient_C* client;
  NAPI_CALL(env, napi_get_value_external(env, args[0], reinterpret_cast<void**>(&client)));

  int connected = mygramclient_is_connected(client);

  napi_value result;
  NAPI_CALL(env, napi_get_boolean(env, connected != 0, &result));
  return result;
}


/**
 * Search for documents (simple version)
 *
 * @param {External} client - Client handle
 * @param {string} table - Table name
 * @param {string} query - Search query
 * @param {number} limit - Maximum results
 * @param {number} offset - Result offset
 * @returns {Object} Search result with primary_keys array and total_count
 */
static napi_value SearchSimple(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));

  if (argc < 5) {
    ThrowError(env, "Expected 5 arguments: client, table, query, limit, offset");
    return nullptr;
  }

  // Extract arguments
  MygramClient_C* client;
  NAPI_CALL(env, napi_get_value_external(env, args[0], reinterpret_cast<void**>(&client)));

  char table[256];
  size_t table_len;
  NAPI_CALL(env, napi_get_value_string_utf8(env, args[1], table, sizeof(table), &table_len));

  char query[4096];
  size_t query_len;
  NAPI_CALL(env, napi_get_value_string_utf8(env, args[2], query, sizeof(query), &query_len));

  int limit;
  NAPI_CALL(env, napi_get_value_int32(env, args[3], &limit));

  int offset;
  NAPI_CALL(env, napi_get_value_int32(env, args[4], &offset));

  // Perform search
  MygramSearchResult_C* result = nullptr;
  int rc = mygramclient_search(client, table, query, static_cast<uint32_t>(limit),
                                static_cast<uint32_t>(offset), &result);

  if (rc != 0 || result == nullptr) {
    const char* error = mygramclient_get_last_error(client);
    ThrowError(env, error ? error : "Search failed");
    return nullptr;
  }

  // Create result object
  napi_value ret_obj;
  NAPI_CALL(env, napi_create_object(env, &ret_obj));

  // Add total_count
  napi_value total_count_val;
  NAPI_CALL(env, napi_create_int64(env, static_cast<int64_t>(result->total_count), &total_count_val));
  NAPI_CALL(env, napi_set_named_property(env, ret_obj, "total_count", total_count_val));

  // Add primary_keys array
  napi_value pkeys_array;
  NAPI_CALL(env, napi_create_array_with_length(env, result->count, &pkeys_array));

  for (size_t i = 0; i < result->count; i++) {
    napi_value pkey_val;
    NAPI_CALL(env, napi_create_string_utf8(env, result->primary_keys[i], NAPI_AUTO_LENGTH, &pkey_val));
    NAPI_CALL(env, napi_set_element(env, pkeys_array, static_cast<uint32_t>(i), pkey_val));
  }

  NAPI_CALL(env, napi_set_named_property(env, ret_obj, "primary_keys", pkeys_array));

  // Free result
  mygramclient_free_search_result(result);

  return ret_obj;
}

/**
 * Get last error message
 *
 * @param {External} client - Client handle
 * @returns {string} Error message
 */
static napi_value GetLastError(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));

  if (argc < 1) {
    ThrowError(env, "Expected client handle");
    return nullptr;
  }

  MygramClient_C* client;
  NAPI_CALL(env, napi_get_value_external(env, args[0], reinterpret_cast<void**>(&client)));

  const char* error = mygramclient_get_last_error(client);

  napi_value result;
  NAPI_CALL(env, napi_create_string_utf8(env, error ? error : "", NAPI_AUTO_LENGTH, &result));
  return result;
}

/**
 * Send raw command to server
 *
 * @param {External} client - Client handle
 * @param {string} command - Command string (without \r\n terminator)
 * @returns {string} Response from server
 */
static napi_value SendCommand(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));

  if (argc < 2) {
    ThrowError(env, "Expected 2 arguments: client, command");
    return nullptr;
  }

  // Extract client handle
  MygramClient_C* client;
  NAPI_CALL(env, napi_get_value_external(env, args[0], reinterpret_cast<void**>(&client)));

  // Extract command string
  char command[8192];
  size_t command_len;
  NAPI_CALL(env, napi_get_value_string_utf8(env, args[1], command, sizeof(command), &command_len));

  // Send command
  char* response = nullptr;
  int rc = mygramclient_send_command(client, command, &response);

  if (rc != 0) {
    const char* error = mygramclient_get_last_error(client);
    ThrowError(env, error ? error : "Command failed");
    if (response) {
      mygramclient_free_string(response);
    }
    return nullptr;
  }

  // Create result string
  napi_value result;
  NAPI_CALL(env, napi_create_string_utf8(env, response ? response : "", NAPI_AUTO_LENGTH, &result));

  // Free response
  if (response) {
    mygramclient_free_string(response);
  }

  return result;
}

/**
 * Parse web-style search expression into structured terms
 *
 * @param {string} expression - Web-style search expression (e.g., "hello world", "+required -excluded")
 * @returns {Object} Parsed expression with mainTerm, andTerms, notTerms
 */
static napi_value SimplifySearchExpressionWrapper(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));

  if (argc < 1) {
    ThrowError(env, "Expected expression string");
    return nullptr;
  }

  // Extract expression string
  char expression[4096];
  size_t expression_len;
  NAPI_CALL(env, napi_get_value_string_utf8(env, args[0], expression, sizeof(expression), &expression_len));

  // Parse expression using C++ implementation
  std::string main_term;
  std::vector<std::string> and_terms;
  std::vector<std::string> not_terms;

  bool success = mygramdb::client::SimplifySearchExpression(expression, main_term, and_terms, not_terms);

  if (!success) {
    ThrowError(env, "Failed to parse search expression");
    return nullptr;
  }

  // Create result object
  napi_value result;
  NAPI_CALL(env, napi_create_object(env, &result));

  // Add mainTerm
  napi_value main_term_val;
  NAPI_CALL(env, napi_create_string_utf8(env, main_term.c_str(), NAPI_AUTO_LENGTH, &main_term_val));
  NAPI_CALL(env, napi_set_named_property(env, result, "mainTerm", main_term_val));

  // Add andTerms array
  napi_value and_terms_array;
  NAPI_CALL(env, napi_create_array_with_length(env, and_terms.size(), &and_terms_array));
  for (size_t i = 0; i < and_terms.size(); i++) {
    napi_value term_val;
    NAPI_CALL(env, napi_create_string_utf8(env, and_terms[i].c_str(), NAPI_AUTO_LENGTH, &term_val));
    NAPI_CALL(env, napi_set_element(env, and_terms_array, static_cast<uint32_t>(i), term_val));
  }
  NAPI_CALL(env, napi_set_named_property(env, result, "andTerms", and_terms_array));

  // Add notTerms array
  napi_value not_terms_array;
  NAPI_CALL(env, napi_create_array_with_length(env, not_terms.size(), &not_terms_array));
  for (size_t i = 0; i < not_terms.size(); i++) {
    napi_value term_val;
    NAPI_CALL(env, napi_create_string_utf8(env, not_terms[i].c_str(), NAPI_AUTO_LENGTH, &term_val));
    NAPI_CALL(env, napi_set_element(env, not_terms_array, static_cast<uint32_t>(i), term_val));
  }
  NAPI_CALL(env, napi_set_named_property(env, result, "notTerms", not_terms_array));

  return result;
}

/**
 * Parse web-style search expression
 *
 * @param {string} expression - Search expression (e.g., "+golang -old tutorial")
 * @returns {Object} Parsed expression with mainTerm, andTerms, notTerms, optionalTerms
 */
static napi_value ParseSearchExpressionWrapper(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));

  if (argc < 1) {
    ThrowError(env, "Expected search expression string");
    return nullptr;
  }

  // Get expression string
  size_t expr_len;
  NAPI_CALL(env, napi_get_value_string_utf8(env, args[0], nullptr, 0, &expr_len));

  char* expression = static_cast<char*>(malloc(expr_len + 1));
  if (expression == nullptr) {
    ThrowError(env, "Memory allocation failed");
    return nullptr;
  }

  NAPI_CALL(env, napi_get_value_string_utf8(env, args[0], expression, expr_len + 1, &expr_len));

  // Parse expression
  MygramParsedExpression_C* parsed = nullptr;
  int rc = mygramclient_parse_search_expression(expression, &parsed);
  free(expression);

  if (rc != 0 || parsed == nullptr) {
    ThrowError(env, "Failed to parse search expression");
    return nullptr;
  }

  // Create result object
  napi_value ret_obj;
  NAPI_CALL(env, napi_create_object(env, &ret_obj));

  // Add mainTerm
  napi_value main_term_val;
  NAPI_CALL(env, napi_create_string_utf8(env, parsed->main_term ? parsed->main_term : "",
                                          NAPI_AUTO_LENGTH, &main_term_val));
  NAPI_CALL(env, napi_set_named_property(env, ret_obj, "mainTerm", main_term_val));

  // Add andTerms array
  napi_value and_terms_array;
  NAPI_CALL(env, napi_create_array_with_length(env, parsed->and_count, &and_terms_array));
  for (size_t i = 0; i < parsed->and_count; i++) {
    napi_value term_val;
    NAPI_CALL(env, napi_create_string_utf8(env, parsed->and_terms[i], NAPI_AUTO_LENGTH, &term_val));
    NAPI_CALL(env, napi_set_element(env, and_terms_array, static_cast<uint32_t>(i), term_val));
  }
  NAPI_CALL(env, napi_set_named_property(env, ret_obj, "andTerms", and_terms_array));

  // Add notTerms array
  napi_value not_terms_array;
  NAPI_CALL(env, napi_create_array_with_length(env, parsed->not_count, &not_terms_array));
  for (size_t i = 0; i < parsed->not_count; i++) {
    napi_value term_val;
    NAPI_CALL(env, napi_create_string_utf8(env, parsed->not_terms[i], NAPI_AUTO_LENGTH, &term_val));
    NAPI_CALL(env, napi_set_element(env, not_terms_array, static_cast<uint32_t>(i), term_val));
  }
  NAPI_CALL(env, napi_set_named_property(env, ret_obj, "notTerms", not_terms_array));

  // Add optionalTerms array
  napi_value optional_terms_array;
  NAPI_CALL(env, napi_create_array_with_length(env, parsed->optional_count, &optional_terms_array));
  for (size_t i = 0; i < parsed->optional_count; i++) {
    napi_value term_val;
    NAPI_CALL(env, napi_create_string_utf8(env, parsed->optional_terms[i], NAPI_AUTO_LENGTH, &term_val));
    NAPI_CALL(env, napi_set_element(env, optional_terms_array, static_cast<uint32_t>(i), term_val));
  }
  NAPI_CALL(env, napi_set_named_property(env, ret_obj, "optionalTerms", optional_terms_array));

  // Free parsed expression
  mygramclient_free_parsed_expression(parsed);

  return ret_obj;
}

/**
 * Initialize native module
 */
static napi_value Init(napi_env env, napi_value exports) {
  // Export functions
  napi_property_descriptor desc[] = {
    { "createClient", nullptr, CreateClient, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "connect", nullptr, Connect, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "disconnect", nullptr, Disconnect, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "destroyClient", nullptr, DestroyClient, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "isConnected", nullptr, IsConnected, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "search", nullptr, SearchSimple, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "sendCommand", nullptr, SendCommand, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "getLastError", nullptr, GetLastError, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "simplifySearchExpression", nullptr, SimplifySearchExpressionWrapper, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "parseSearchExpression", nullptr, ParseSearchExpressionWrapper, nullptr, nullptr, nullptr, napi_default, nullptr }
  };

  NAPI_CALL(env, napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
