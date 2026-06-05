import LocalAuthentication
import Foundation

let context = LAContext()
var error: NSError?

let policy = LAPolicy.deviceOwnerAuthentication
let reason = "unlock Canopy and access your agent conversations"

let semaphore = DispatchSemaphore(value: 0)

if context.canEvaluatePolicy(policy, error: &error) {
    context.evaluatePolicy(policy, localizedReason: reason) { success, authError in
        if success {
            print("SUCCESS")
            exit(0)
        } else {
            if let err = authError as? LAError {
                print("ERROR: \(err.code.rawValue) - \(err.localizedDescription)")
            } else {
                print("ERROR: Unknown error")
            }
            exit(1)
        }
    }
    semaphore.wait()
} else {
    print("UNSUPPORTED")
    exit(2)
}
