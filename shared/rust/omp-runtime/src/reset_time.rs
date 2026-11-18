//! When a usage limit resets, in plain UTC wording.

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `Nov 16 at 23:02 UTC` for a time in epoch milliseconds.
pub(crate) fn utc_reset_time(epoch_ms: i64) -> String {
    let seconds = epoch_ms.div_euclid(1000);
    let (_, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let minutes = seconds.rem_euclid(86_400) / 60;
    format!(
        "{} {day} at {:02}:{:02} UTC",
        MONTHS[month as usize - 1],
        minutes / 60,
        minutes % 60
    )
}

/// The Gregorian year, month (1-12), and day of a count of days since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    // Count from 0000-03-01 in 400-year eras, so the leap day ends each year.
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_from_march + 2) / 5 + 1) as u32;
    let month = (if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    }) as u32;
    let year = era * 400 + year_of_era + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::{civil_from_days, utc_reset_time};

    #[test]
    fn formats_known_times_in_utc() {
        assert_eq!(utc_reset_time(0), "Jan 1 at 00:00 UTC");
        assert_eq!(utc_reset_time(1_794_870_120_000), "Nov 16 at 23:02 UTC");
        // A leap day, and the last minute of a year before the next one's first.
        assert_eq!(utc_reset_time(1_709_210_040_000), "Feb 29 at 12:34 UTC");
        assert_eq!(utc_reset_time(1_767_225_599_999), "Dec 31 at 23:59 UTC");
        assert_eq!(utc_reset_time(1_767_225_600_000), "Jan 1 at 00:00 UTC");
    }

    #[test]
    fn converts_day_counts_to_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
        assert_eq!(civil_from_days(20_453), (2025, 12, 31));
        assert_eq!(civil_from_days(20_454), (2026, 1, 1));
        assert_eq!(civil_from_days(47_481), (2099, 12, 31));
    }
}
