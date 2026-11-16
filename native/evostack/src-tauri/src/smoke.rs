pub fn browser_arguments(
    token: Option<&str>,
    port: Option<&str>,
    isolated_profile: bool,
) -> Result<Option<String>, &'static str> {
    if token.is_none() && port.is_none() {
        return Ok(None);
    }
    let token = token.ok_or("EVOSTACK_INVALID_SMOKE_CONFIGURATION")?;
    let raw_port = port.ok_or("EVOSTACK_INVALID_SMOKE_CONFIGURATION")?;
    if !isolated_profile
        || token.len() != 32
        || !token.bytes().all(|value| value.is_ascii_hexdigit())
        || raw_port.is_empty()
        || !raw_port.bytes().all(|value| value.is_ascii_digit())
    {
        return Err("EVOSTACK_INVALID_SMOKE_CONFIGURATION");
    }
    let port = raw_port
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or("EVOSTACK_INVALID_SMOKE_CONFIGURATION")?;
    Ok(Some(format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
         --remote-debugging-address=127.0.0.1 --remote-debugging-port={port} \
         --disable-background-timer-throttling --disable-renderer-backgrounding \
         --disable-backgrounding-occluded-windows"
    )))
}

#[cfg(test)]
mod tests {
    use super::browser_arguments;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn normal_startup_does_not_request_a_debug_listener() {
        assert_eq!(browser_arguments(None, None, false), Ok(None));
        assert_eq!(browser_arguments(None, None, true), Ok(None));
    }

    #[test]
    fn isolated_smoke_uses_only_the_validated_loopback_port() {
        let args = browser_arguments(Some(TOKEN), Some("51337"), true)
            .unwrap()
            .unwrap();
        assert!(args.contains("--remote-debugging-address=127.0.0.1"));
        assert!(args.contains("--remote-debugging-port=51337 "));
        assert!(args.contains("msWebOOUI,msPdfOOUI,msSmartScreenProtection"));
        assert!(!args.contains(TOKEN));
    }

    #[test]
    fn smoke_requires_both_a_token_and_an_explicit_isolated_profile() {
        assert!(browser_arguments(None, Some("51337"), true).is_err());
        assert!(browser_arguments(Some(TOKEN), None, true).is_err());
        assert!(browser_arguments(Some(TOKEN), Some("51337"), false).is_err());
        assert!(browser_arguments(Some("not-a-token"), Some("51337"), true).is_err());
    }

    #[test]
    fn malformed_ports_cannot_inject_browser_arguments() {
        for port in [
            "",
            "0",
            "65536",
            "-1",
            "51337 --no-sandbox",
            "127.0.0.1:51337",
        ] {
            assert!(browser_arguments(Some(TOKEN), Some(port), true).is_err());
        }
    }
}
