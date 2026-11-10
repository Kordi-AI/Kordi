//! Automatic update timing and caps, with the documented defaults. Each one
//! can be overridden with a `KORDI_COMMON_GROUND_AUTO_*` variable.

use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutoRebuildConfig {
    /// Seconds between sweeps (`KORDI_COMMON_GROUND_AUTO_SWEEP_SECONDS`, 30).
    pub sweep_seconds: u64,
    /// The latest change must be this old
    /// (`KORDI_COMMON_GROUND_AUTO_QUIET_SECONDS`, 300) ...
    pub quiet_seconds: i64,
    /// ... or the first unhandled one this old
    /// (`KORDI_COMMON_GROUND_AUTO_MAX_WAIT_SECONDS`, 1800).
    pub max_wait_seconds: i64,
    /// Automatic updates per card in an hour
    /// (`KORDI_COMMON_GROUND_AUTO_HOURLY_UPDATES`, 2).
    pub hourly_updates: i64,
    /// Automatic updates per card in 24 hours
    /// (`KORDI_COMMON_GROUND_AUTO_DAILY_UPDATES`, 12).
    pub daily_updates: i64,
}

impl Default for AutoRebuildConfig {
    fn default() -> Self {
        Self {
            sweep_seconds: 30,
            quiet_seconds: 300,
            max_wait_seconds: 1_800,
            hourly_updates: 2,
            daily_updates: 12,
        }
    }
}

impl AutoRebuildConfig {
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let read = |key: &str, range: std::ops::RangeInclusive<i64>, default: i64| {
            lookup(&format!("KORDI_COMMON_GROUND_AUTO_{key}"))
                .and_then(|value| value.trim().parse::<i64>().ok())
                .filter(|value| range.contains(value))
                .unwrap_or(default)
        };
        let defaults = Self::default();
        Self {
            sweep_seconds: read("SWEEP_SECONDS", 1..=3_600, defaults.sweep_seconds as i64) as u64,
            quiet_seconds: read("QUIET_SECONDS", 0..=86_400, defaults.quiet_seconds),
            max_wait_seconds: read("MAX_WAIT_SECONDS", 0..=86_400, defaults.max_wait_seconds),
            hourly_updates: read("HOURLY_UPDATES", 0..=100, defaults.hourly_updates),
            daily_updates: read("DAILY_UPDATES", 0..=1_000, defaults.daily_updates),
        }
    }
}

/// The configuration read from the environment once.
pub(in crate::common_ground) fn config() -> AutoRebuildConfig {
    static CONFIG: OnceLock<AutoRebuildConfig> = OnceLock::new();
    *CONFIG.get_or_init(|| AutoRebuildConfig::from_lookup(|key| std::env::var(key).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_follow_the_document_and_env_overrides_are_bounded() {
        assert_eq!(
            AutoRebuildConfig::from_lookup(|_| None),
            AutoRebuildConfig::default()
        );
        let config = AutoRebuildConfig::from_lookup(|key| match key {
            "KORDI_COMMON_GROUND_AUTO_QUIET_SECONDS" => Some("0".into()),
            "KORDI_COMMON_GROUND_AUTO_DAILY_UPDATES" => Some(" 3 ".into()),
            "KORDI_COMMON_GROUND_AUTO_SWEEP_SECONDS" => Some("0".into()),
            "KORDI_COMMON_GROUND_AUTO_HOURLY_UPDATES" => Some("often".into()),
            _ => None,
        });
        assert_eq!(config.quiet_seconds, 0);
        assert_eq!(config.daily_updates, 3);
        assert_eq!(config.sweep_seconds, 30, "out of range keeps the default");
        assert_eq!(config.hourly_updates, 2);
        assert_eq!(config.max_wait_seconds, 1_800);
    }
}
