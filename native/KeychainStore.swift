import Foundation
import Security

let service = "com.thales.synapse-call-local.api-key"
let account = "synapse"
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

guard CommandLine.arguments.count == 2 else { exit(2) }

switch CommandLine.arguments[1] {
case "get":
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { exit(0) }
    guard status == errSecSuccess, let data = result as? Data else { exit(1) }
    FileHandle.standardOutput.write(data)
case "set":
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else { exit(2) }
    let attributes = [kSecValueData as String: data]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = data
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { exit(1) }
    } else if status != errSecSuccess { exit(1) }
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    if status != errSecSuccess && status != errSecItemNotFound { exit(1) }
default:
    exit(2)
}
