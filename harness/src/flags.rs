//! The `--name value` flags of the two tools.
//!
//! The grammar is strict: a flag the tool does not know, a flag given twice
//! or a flag without a value is refused, with the usage line as the fix. A
//! typing mistake must never run a test with a default nobody chose.

use std::collections::BTreeMap;
use std::str::FromStr;

use crate::Refusal;

/// The flags one tool was started with.
pub struct Flags {
    values: BTreeMap<String, String>,
    usage: &'static str,
}

impl Flags {
    /// Reads `--name value` pairs. `known` lists the names the tool takes,
    /// and `usage` is the fix shown with every refusal.
    pub fn parse(
        args: impl IntoIterator<Item = String>,
        known: &[&str],
        usage: &'static str,
    ) -> Result<Self, Refusal> {
        let mut flags = Self {
            values: BTreeMap::new(),
            usage,
        };
        let mut args = args.into_iter();
        while let Some(name) = args.next() {
            if !known.contains(&name.as_str()) {
                return Err(flags.refusal(format!("{name} is not a flag of this tool")));
            }
            let Some(value) = args.next() else {
                return Err(flags.refusal(format!("{name} needs a value")));
            };
            if flags.values.insert(name.clone(), value).is_some() {
                return Err(flags.refusal(format!("{name} was given twice")));
            }
        }
        Ok(flags)
    }

    /// The value of a flag, when it was given.
    fn text(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    /// The value of a flag the tool cannot run without.
    pub fn required(&self, name: &str) -> Result<&str, Refusal> {
        self.text(name)
            .ok_or_else(|| self.refusal(format!("{name} is missing")))
    }

    /// The value of a whole-number flag the tool cannot run without.
    pub fn required_number<T: FromStr>(&self, name: &str) -> Result<T, Refusal> {
        self.parse_number(name, self.required(name)?)
    }

    /// The value of a flag that is a whole number, when it was given.
    pub fn number<T: FromStr>(&self, name: &str) -> Result<Option<T>, Refusal> {
        let Some(text) = self.text(name) else {
            return Ok(None);
        };
        self.parse_number(name, text).map(Some)
    }

    /// The values of a flag that is a list of whole numbers with commas
    /// between them, when it was given.
    pub fn numbers<T: FromStr>(&self, name: &str) -> Result<Option<Vec<T>>, Refusal> {
        let Some(text) = self.text(name) else {
            return Ok(None);
        };
        let numbers = text.split(',').map(|item| self.parse_number(name, item));
        numbers.collect::<Result<_, _>>().map(Some)
    }

    fn parse_number<T: FromStr>(&self, name: &str, text: &str) -> Result<T, Refusal> {
        text.parse().map_err(|_| {
            self.refusal(format!(
                "{name} takes a whole number in range, not {text:?}"
            ))
        })
    }

    fn refusal(&self, cause: String) -> Refusal {
        Refusal {
            cause,
            fix: format!("usage: {}", self.usage),
        }
    }
}

/// The value of an environment variable that carries a secret. A secret is
/// never a flag: flags show in the process list and in shell history.
pub fn secret(name: &str) -> Result<String, Refusal> {
    std::env::var(name).map_err(|_| Refusal {
        cause: format!("{name} is not set"),
        fix: format!("export {name} with the credential the system under test accepts"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: &[&str] = &["--rate", "--bytes", "--proxy"];

    fn parse(args: &[&str]) -> Result<Flags, Refusal> {
        Flags::parse(
            args.iter().map(|arg| (*arg).to_owned()),
            KNOWN,
            "tool --rate <n>",
        )
    }

    #[test]
    fn flags_are_read_as_pairs() {
        let flags = parse(&[
            "--rate",
            "500",
            "--bytes",
            "0,1024",
            "--proxy",
            "127.0.0.1:1",
        ])
        .unwrap();
        assert_eq!(flags.number::<u32>("--rate").unwrap(), Some(500));
        assert_eq!(
            flags.numbers::<u64>("--bytes").unwrap(),
            Some(vec![0, 1024])
        );
        assert_eq!(flags.required("--proxy").unwrap(), "127.0.0.1:1");
        assert_eq!(flags.required_number::<u32>("--rate").unwrap(), 500);
        assert_eq!(parse(&[]).unwrap().number::<u32>("--rate").unwrap(), None);
    }

    #[test]
    fn anything_else_is_refused_with_the_usage() {
        let refused = [
            parse(&["--rat", "500"]).err(),
            parse(&["--rate"]).err(),
            parse(&["--rate", "1", "--rate", "2"]).err(),
            parse(&["500"]).err(),
            parse(&[]).unwrap().required("--proxy").err(),
            parse(&[]).unwrap().required_number::<u32>("--rate").err(),
            parse(&["--rate", "fast"])
                .unwrap()
                .number::<u32>("--rate")
                .err(),
            parse(&["--rate", "-1"])
                .unwrap()
                .number::<u32>("--rate")
                .err(),
            parse(&["--bytes", "1,,2"])
                .unwrap()
                .numbers::<u64>("--bytes")
                .err(),
        ];
        for refusal in refused {
            let refusal = refusal.expect("a refusal");
            assert_eq!(refusal.fix, "usage: tool --rate <n>", "{}", refusal.cause);
        }
    }
}
