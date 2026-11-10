import CoreLocation
import UIKit

/// Keeps the signed-in account's automatic Location and Time zone (#2439) in
/// step with this iPhone: at sign-in, when the app becomes active, when the
/// system time zone changes, and when Nearby already receives a location
/// that moved. The server writes a field only while it is automatic. Only a
/// city name is sent; the fix itself stays in memory on this iPhone.
@MainActor
final class ProfileDeviceSync {
    static let shared = ProfileDeviceSync()
    /// A fix closer than this to the last one reuses its city.
    static let sameCityMeters: CLLocationDistance = 5_000

    enum CityLookup: Equatable {
        case city(String)
        case denied
        case unavailable
    }

    private weak var model: AppModel?
    private var observing = false
    private var running = false
    private var launched = false
    private var lastKey: String?
    private var lastFix: CLLocation?
    private var lastCity: String?
    private let defaults = UserDefaults.standard

    /// Called whenever the account changes; syncs when the account or a mode changed.
    func accountChanged(_ model: AppModel) {
        self.model = model
        observe()
        guard let account = model.account, !model.isPreviewMode else {
            lastKey = nil
            return
        }
        let key = "\(account.accountId)|\(account.timeZoneMode ?? "")|\(account.locationMode ?? "")"
        guard key != lastKey else { return }
        lastKey = key
        Task { await sync(checkCity: true) }
    }

    /// Nearby received a location; a move to another city refreshes the label.
    func deviceMoved(_ location: CLLocation) {
        guard !running, model?.account?.locationMode == ProfileFieldMode.automatic else { return }
        if let lastFix, location.distance(from: lastFix) < Self.sameCityMeters { return }
        Task { await sync(checkCity: true, fix: location) }
    }

    /// This iPhone's city. With `prompt`, asks for When In Use access first.
    func currentCity(prompt: Bool) async -> CityLookup {
        let locator = CommonGroundNearbyLocator.shared
        if prompt { await locator.requestAccess(background: false) }
        switch locator.access {
        case .denied, .restricted: return .denied
        case .notDetermined: return .unavailable
        case .whenInUse, .always: break
        }
        guard let fix = await locator.oneFix(timeout: 20) else { return .unavailable }
        return await city(for: fix).map(CityLookup.city) ?? .unavailable
    }

    private func observe() {
        guard !observing else { return }
        observing = true
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in await ProfileDeviceSync.shared.sync(checkCity: true) }
        }
        center.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main) { _ in
            Task { @MainActor in await ProfileDeviceSync.shared.sync(checkCity: false) }
        }
    }

    private func city(for fix: CLLocation) async -> String? {
        if let lastFix, let lastCity, fix.distance(from: lastFix) < Self.sameCityMeters { return lastCity }
        // English, so every device writes the same label.
        guard let place = try? await CLGeocoder()
            .reverseGeocodeLocation(fix, preferredLocale: Locale(identifier: "en_US")).first,
            let label = ProfileCityLabel.make(place) else { return nil }
        lastFix = fix
        lastCity = label
        return label
    }

    private func sync(checkCity: Bool, fix: CLLocation? = nil) async {
        guard !running, let model, let account = model.account, !model.isPreviewMode,
              account.timeZoneMode != nil, account.locationMode != nil else { return }
        running = true
        defer { running = false }
        var memory = ProfileDeviceMemory.load(accountId: account.accountId, from: defaults)
        let now = Date()
        let lookUpCity = checkCity && account.locationMode == ProfileFieldMode.automatic
            && CommonGroundNearbyLocator.shared.access.granted
            && (fix != nil || !launched || memory.cityDue(now: now))
        launched = true
        var location: String?
        if lookUpCity {
            memory.locationCheckedAt = now
            if let fix {
                location = await city(for: fix)
            } else if case .city(let city) = await currentCity(prompt: false) {
                location = city
            }
        }
        guard let latest = model.account, latest.accountId == account.accountId else { return }
        let update = ProfileDeviceRule.update(
            account: latest,
            timeZone: TimeZone.current.identifier,
            location: location,
            memory: memory
        )
        if update.timeZone != nil || update.location != nil {
            guard let (api, token, _) = try? model.projectContext(),
                  (try? await api.updateDeviceProfile(token: token, timeZone: update.timeZone, location: update.location)) != nil
            else { return }
            // Loads the account the server now holds.
            _ = await model.refreshWorkspace(showSyncActivity: false)
        }
        update.memory.save(accountId: account.accountId, to: defaults)
    }
}

/// What this iPhone last observed for one account.
struct ProfileDeviceMemory: Codable, Equatable {
    /// A city lookup at most this often, except at launch and when turned on.
    static let cityInterval: TimeInterval = 30 * 60

    var timeZone: String?
    var location: String?
    var locationCheckedAt: Date?

    private static func key(_ accountId: String) -> String { "ai.kordi.profileDeviceSync.\(accountId)" }

    static func load(accountId: String, from defaults: UserDefaults) -> ProfileDeviceMemory {
        guard let data = defaults.data(forKey: key(accountId)),
              let memory = try? JSONDecoder().decode(ProfileDeviceMemory.self, from: data) else { return ProfileDeviceMemory() }
        return memory
    }

    func save(accountId: String, to defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.key(accountId)) }
    }

    func cityDue(now: Date) -> Bool {
        guard let locationCheckedAt else { return true }
        let elapsed = now.timeIntervalSince(locationCheckedAt)
        return elapsed < 0 || elapsed >= Self.cityInterval
    }
}

/// Which observed values to send, matching the Mac: a first observation on
/// this device only fills an empty field; after that, a value is sent when
/// this device saw it change and the account does not already hold it.
enum ProfileDeviceRule {
    static func update(
        account: CloudAccount,
        timeZone: String?,
        location: String?,
        memory: ProfileDeviceMemory
    ) -> (timeZone: String?, location: String?, memory: ProfileDeviceMemory) {
        var next = memory
        func decide(_ observed: String?, previous: String?, current: String?, mode: String?) -> String? {
            guard let value = observed?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty,
                  mode == ProfileFieldMode.automatic, value != previous else { return nil }
            let current = current?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if value == current || (previous == nil && !current.isEmpty) { return nil }
            return value
        }
        let sendTimeZone = decide(timeZone, previous: memory.timeZone, current: account.timeZone, mode: account.timeZoneMode)
        let sendLocation = decide(location, previous: memory.location, current: account.location, mode: account.locationMode)
        if let timeZone = timeZone?.nonEmpty { next.timeZone = timeZone }
        if let location = location?.nonEmpty { next.location = location }
        return (sendTimeZone, sendLocation, next)
    }
}

/// "Palo Alto, CA" in the United States, "Thuwal, Saudi Arabia" elsewhere;
/// the same rule as the Mac app. Never more precise than a town.
enum ProfileCityLabel {
    static let maxLength = 80

    static func make(_ place: CLPlacemark) -> String? {
        make(
            locality: place.locality,
            subAdministrativeArea: place.subAdministrativeArea,
            administrativeArea: place.administrativeArea,
            country: place.country,
            isoCountryCode: place.isoCountryCode
        )
    }

    static func make(
        locality: String?,
        subAdministrativeArea: String?,
        administrativeArea: String?,
        country: String?,
        isoCountryCode: String?
    ) -> String? {
        func clean(_ value: String?) -> String? {
            value?.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ").nonEmpty
        }
        let unitedStates = clean(isoCountryCode)?.uppercased() == "US"
        let town = clean(locality) ?? clean(subAdministrativeArea) ?? clean(administrativeArea)
        let region = unitedStates ? (clean(administrativeArea) ?? clean(country)) : clean(country)
        let label: String
        switch (town, region) {
        case let (town?, region?) where town != region: label = "\(town), \(region)"
        case let (town?, _): label = town
        case let (nil, region?): label = region
        case (nil, nil): return nil
        }
        return String(label.prefix(maxLength)).trimmingCharacters(in: .whitespaces)
    }
}

extension ProfileDraft {
    /// Turning automatic Location off keeps the city shown and makes it manual.
    mutating func turnOffAutomaticLocation(saved: ProfileDraft) {
        if deviceOwnsLocation(saved: saved) { location = saved.location }
        locationMode = ProfileFieldMode.manual
    }

    /// Applies turning automatic Location on; returns a note to show, if any.
    /// Denied access keeps the person's choice and leaves the field as it is.
    mutating func apply(_ lookup: ProfileDeviceSync.CityLookup) -> String? {
        switch lookup {
        case .city(let city):
            location = city
            locationMode = ProfileFieldMode.automatic
        case .denied:
            locationMode = ProfileFieldMode.automatic
        case .unavailable:
            return "Could not find your city."
        }
        return nil
    }
}
