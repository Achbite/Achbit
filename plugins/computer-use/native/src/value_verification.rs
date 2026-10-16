//! Read back a retained control after one write; never retry the write itself.
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub fn verify(
    expected: &str,
    read: impl FnMut() -> Result<Value, String>,
) -> Result<Value, String> {
    poll(expected, Duration::from_secs(2), read)
}

fn poll(
    expected: &str,
    timeout: Duration,
    mut read: impl FnMut() -> Result<Value, String>,
) -> Result<Value, String> {
    let started = Instant::now();
    loop {
        let actual = read()?;
        let matched = actual.as_str() == Some(expected);
        if matched || started.elapsed() >= timeout {
            return Ok(json!({"expected":expected,"actual":actual,"matched":matched}));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn record(result: &mut Value, verification: Result<Value, String>) {
    match verification {
        Ok(verification) => {
            if verification["matched"] != true {
                result["actionError"] = json!({"message":format!(
                    "setValue was dispatched, but the observed value did not match: expected {}, observed {}. Inspect the returned observation before deciding any further action.",
                    verification["expected"], verification["actual"])});
            }
            result["valueVerification"] = verification;
        }
        Err(message) => {
            result["actionError"] = json!({"message":format!(
                "setValue was dispatched, but its value could not be verified: {message}. Inspect before deciding any further action.")});
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delayed_application_is_read_until_confirmed() {
        let mut values = [json!("before"), json!("after")].into_iter();
        let result = verify("after", || {
            Ok(values.next().expect("no read after confirmation"))
        })
        .unwrap();
        assert_eq!(
            result,
            json!({"expected":"after","actual":"after","matched":true})
        );
    }

    #[test]
    fn mismatch_and_lost_control_preserve_dispatch_without_claiming_success() {
        let mut result = json!({"dispatched":true});
        record(&mut result, poll("123", Duration::ZERO, || Ok(json!(123))));
        assert_eq!(result["dispatched"], true);
        assert_eq!(result["valueVerification"]["matched"], false);
        assert!(result["actionError"]["message"]
            .as_str()
            .unwrap()
            .contains("did not match"));
        let mut result = json!({"dispatched":true});
        record(
            &mut result,
            verify("after", || Err("control closed".into())),
        );
        assert_eq!(result["dispatched"], true);
        assert!(result["valueVerification"].is_null());
        assert!(result["actionError"]["message"]
            .as_str()
            .unwrap()
            .contains("control closed"));
    }
}
