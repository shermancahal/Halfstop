import Foundation
import UIKit
import Capacitor
import AuthenticationServices

/*
 * Sign in with Apple, with Apple's own sheet.
 *
 * The page asks; this shows the sheet and hands back what Apple returned. It
 * decides nothing: the identity token goes to Supabase, which checks Apple's
 * signature, the audience (the bundle id named in the Apple provider's Client
 * IDs) and the nonce before it makes a session.
 *
 * The nonce arrives already hashed. Apple puts whatever it is given into the
 * token, and Supabase compares the token's value with the SHA-256 of the raw
 * nonce the page keeps - so the raw one never passes through here.
 *
 * Written here rather than taken from npm because the community plugin pins
 * Capacitor 7's Swift package, which a Capacitor 8 project cannot resolve, and
 * the alternative bundles the Facebook and Google SDKs into the app.
 */
@objc(SignInWithApplePlugin)
public class SignInWithApplePlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "SignInWithApplePlugin"
    public let jsName = "SignInWithApple"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
    ]

    /// The call waiting for Apple's answer. One at a time: Apple shows one sheet.
    private var pending: CAPPluginCall?
    /// Held so the controller lives until its delegate has been called.
    private var controller: ASAuthorizationController?

    @objc func authorize(_ call: CAPPluginCall) {
        let nonce = call.getString("nonce") ?? ""
        DispatchQueue.main.async {
            if let previous = self.pending {
                previous.reject("Another Sign in with Apple was started.", "SUPERSEDED")
            }
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName, .email]
            if !nonce.isEmpty {
                request.nonce = nonce
            }
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.pending = call
            self.controller = controller
            controller.performRequests()
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        if let window = self.bridge?.viewController?.view.window {
            return window
        }
        return ASPresentationAnchor()
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = self.pending else { return }
        self.pending = nil
        self.controller = nil

        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8) else {
            call.reject("Apple did not return a sign-in token.", "NO_TOKEN")
            return
        }

        var authorizationCode = ""
        if let codeData = credential.authorizationCode,
           let code = String(data: codeData, encoding: .utf8) {
            authorizationCode = code
        }

        // The name and address come only the first time somebody signs in to
        // this app with Apple; every later answer has them empty.
        call.resolve([
            "identityToken": identityToken,
            "authorizationCode": authorizationCode,
            "user": credential.user,
            "email": credential.email ?? "",
            "givenName": credential.fullName?.givenName ?? "",
            "familyName": credential.fullName?.familyName ?? ""
        ])
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithError error: Error) {
        guard let call = self.pending else { return }
        self.pending = nil
        self.controller = nil

        var code = "FAILED"
        if let failure = error as? ASAuthorizationError {
            code = failure.code == .canceled ? "CANCELED" : "FAILED_\(failure.code.rawValue)"
        }
        call.reject(error.localizedDescription, code, error)
    }
}
