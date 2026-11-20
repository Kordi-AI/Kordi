import Foundation

// The one handler for a session Kordi Cloud ended (`ServerSessionEnd`). It is
// reached from launch, `refreshWorkspace`, the sync pass, the realtime ticket
// and socket, and the browser sign-in refresh.
//
// - `account_deleted`: the self-serve deletion's teardown (calls, sign-out
//   without server calls, `AccountDeletionCleanup.wipe`), with no notice.
// - `invalid_session` / `login_required`: a sign-out without server calls,
//   then the sign-in screen with a one-line notice. A browser sign-in first
//   gets one refresh, because an expired access token answers the same.
extension AppModel {
    static let sessionEndedNotice = "Your session expired. Sign in again."

    /// Ends the session for a request made with `token` when the server
    /// answered that it ended. Returns the running teardown, or nil when the
    /// answer no longer applies (signed out, preview, another sign-in).
    /// However many requests report it, one teardown runs.
    @discardableResult
    func endSession(_ end: ServerSessionEnd, token: String?, confirmed: Bool = false) -> Task<Void, Never>? {
        guard !isPreviewMode, phase == .signedIn else { return nil }
        switch end {
        case .accountDeleted:
            // Any token of this sign-in shows the account is gone.
            guard isCurrentSignIn(token) else { return nil }
        case .signedOut:
            // Only the token in use: an older one may just have rotated.
            guard let token, token == sessionToken else { return nil }
        }
        return beginSessionEnd(end, token: token, confirmed: confirmed, prepareCalls: nil)
    }

    /// After this iPhone deleted the account: the same teardown, shared
    /// with a deletion the sync loop or realtime noticed first.
    func finishAccountDeletion(token: String, accountId: String, prepareCalls: @escaping @MainActor () async -> Void) async {
        guard serverSessionEndTask != nil || (phase == .signedIn && isCurrentSignIn(token)) else {
            // A sign-out teardown already finished; the calls and the wipe are left.
            await prepareCalls()
            AccountDeletionCleanup.wipe(accountId: accountId, defaults: localDefaults)
            return
        }
        await beginSessionEnd(.accountDeleted, token: token, confirmed: true, prepareCalls: prepareCalls).value
    }

    /// Ends a stored session the server refused while it is not signed in on
    /// screen: at launch, or a browser sign-in kept after a failed launch.
    /// It clears what a sign-out clears, every cached account (nobody is
    /// signed in), and for a deleted account the wipe.
    func endStoredSession(_ end: ServerSessionEnd, showsNotice: Bool) async {
        let accountId = await storedSessionAccountId()
        if end == .accountDeleted {
            await prepareCallsForAccountTeardown?()
            await signOut(accountDeleted: true)
        } else {
            await signOut(sessionEnded: true)
        }
        await clearCachedAccounts()
        if end == .accountDeleted, let accountId {
            AccountDeletionCleanup.wipe(accountId: accountId, defaults: localDefaults)
        }
        errorMessage = showsNotice && end == .signedOut ? Self.sessionEndedNotice : nil
    }

    private func beginSessionEnd(
        _ end: ServerSessionEnd,
        token: String?,
        confirmed: Bool,
        prepareCalls: (@MainActor () async -> Void)?
    ) -> Task<Void, Never> {
        if end == .accountDeleted {
            // A deleted account never comes back: stop retrying at once, and
            // make a sign-out teardown that is already running wipe as well.
            serverSessionEndWipesAccount = true
            stopSessionRetries()
        }
        if let running = serverSessionEndTask { return running }
        let accountId = account?.accountId
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.finishSessionEnd(end, token: token, accountId: accountId, confirmed: confirmed, prepareCalls: prepareCalls)
            self.serverSessionEndTask = nil
            self.serverSessionEndWipesAccount = false
        }
        serverSessionEndTask = task
        return task
    }

    private func finishSessionEnd(
        _ end: ServerSessionEnd,
        token: String?,
        accountId: String?,
        confirmed: Bool,
        prepareCalls: (@MainActor () async -> Void)?
    ) async {
        if end == .signedOut, !confirmed, let token {
            switch await recheckBrowserSession(afterRejected: token) {
            case .kept:
                guard serverSessionEndWipesAccount else { return }
            case .accountDeleted:
                serverSessionEndWipesAccount = true
                stopSessionRetries()
            case .ended, .notBrowserSession:
                break
            }
        }
        let prepare = prepareCalls ?? prepareCallsForAccountTeardown
        if phase == .signedOut {
            // Signed out meanwhile: only a deleted account's teardown is left.
            if serverSessionEndWipesAccount {
                await prepare?()
                if let accountId { AccountDeletionCleanup.wipe(accountId: accountId, defaults: localDefaults) }
                errorMessage = nil
            }
            return
        }
        // Another sign-in may have started meanwhile; never end that one.
        guard isCurrentSignIn(token) else { return }
        var preparedCalls = false
        if serverSessionEndWipesAccount {
            await prepare?()
            preparedCalls = true
            await signOut(accountDeleted: true)
        } else {
            await signOut(sessionEnded: true)
        }
        // Read again: a deletion can be reported while the sign-out runs.
        if serverSessionEndWipesAccount {
            if !preparedCalls { await prepare?() }
            if let accountId { AccountDeletionCleanup.wipe(accountId: accountId, defaults: localDefaults) }
            errorMessage = nil
        } else {
            errorMessage = Self.sessionEndedNotice
        }
    }

    /// The account of the stored session, before it is removed: the browser
    /// sign-in's, else the one the share extension was given.
    private func storedSessionAccountId() async -> String? {
        if let accountId = await browserSignIn.store.credential()?.accountId.nonEmpty { return accountId }
        return (try? shareCredentialStore.load())?.accountID.nonEmpty
    }
}
