/// flavor.rs — Prod/dev flavor isolation (IMPLEMENTATION_PLAN_DEV_FLAVOR_ISOLATION).
///
/// The installed production app and a source checkout (`tauri dev`) used to be the
/// *same app* to macOS and Docker: same container names, same host ports, same
/// keychain service, same data dir. A dev session could therefore corrupt real
/// agent state (and on 2026-08-15 a fresh-instance test run adopted the live
/// gateway's containers as its own fleet).
///
/// One code path, two flavors selected at startup. No `if dev` scattered through
/// logic — every previously-hardcoded value routes through the single [`Flavor`]
/// returned by [`flavor()`].
///
/// Selection order:
///   1. `CANOPY_FLAVOR=dev` / `CANOPY_FLAVOR=prod` env var, if set.
///   2. Build default: debug builds → dev, release builds → prod.
use std::path::PathBuf;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Flavor {
    /// Short name: `"prod"` or `"dev"`. Also what the frontend badge renders.
    pub name: &'static str,
    /// Shared gateway container name.
    pub gateway_container: &'static str,
    /// Prefix for per-agent isolated containers (`<prefix><agent_id>`).
    pub isolated_prefix: &'static str,
    /// Host-side port mapped to the gateway's container port 18789.
    pub gateway_host_port: u16,
    /// Host-side ports mapped to the gateway's auxiliary container ports
    /// 18790/18791 (browser/canvas endpoints in the compose template).
    pub gateway_aux_host_ports: (u16, u16),
    /// Base of the host-port range isolated agent containers hash into
    /// (`base + hash % ISOLATED_PORT_RANGE`).
    pub isolated_port_base: u16,
    /// Port the JIT provisioning server binds on the host.
    pub jit_port: u16,
    /// macOS Keychain service name for the credential vault.
    pub keychain_service: &'static str,
    /// Directory name under the OS data dir holding all Canopy state.
    pub data_dir_name: &'static str,
    /// OS deep-link scheme (`canopy://` vs `canopy-dev://`). Must match the
    /// `deep-link` plugin schemes in tauri.conf.json / tauri.dev.conf.json.
    pub deep_link_scheme: &'static str,
    /// Chroma (vector DB) container name in the gateway compose file.
    pub chroma_container: &'static str,
    /// Host-side port mapped to Chroma's container port 8000.
    pub chroma_host_port: u16,
    /// Explicit docker-compose project name (top-level `name:` key). Without it
    /// compose derives the project from the data dir's basename, which is
    /// "Canopy" for BOTH flavors under a CANOPY_DATA_DIR override — compose
    /// would then treat the other flavor's running containers as this project's
    /// and recreate them.
    pub compose_project: &'static str,
}

/// Number of host ports reserved for isolated agent containers per flavor.
pub const ISOLATED_PORT_RANGE: u16 = 195;

pub const PROD: Flavor = Flavor {
    name: "prod",
    gateway_container: "canopy-gateway",
    isolated_prefix: "canopy-isolated-",
    gateway_host_port: 18799,
    gateway_aux_host_ports: (18800, 18801),
    isolated_port_base: 18805,
    jit_port: 18802,
    keychain_service: "com.canopy.app",
    data_dir_name: "Canopy",
    deep_link_scheme: "canopy",
    chroma_container: "canopy-chroma",
    chroma_host_port: 8000,
    compose_project: "canopy",
};

pub const DEV: Flavor = Flavor {
    name: "dev",
    gateway_container: "canopy-gateway-dev",
    isolated_prefix: "canopy-isolated-dev-",
    gateway_host_port: 18797,
    gateway_aux_host_ports: (18794, 18795),
    // 19305–19499: far from the prod range (18805–18999) and every fixed port.
    isolated_port_base: 19305,
    jit_port: 18796,
    keychain_service: "com.canopy.app.dev",
    data_dir_name: "CanopyDev",
    deep_link_scheme: "canopy-dev",
    chroma_container: "canopy-chroma-dev",
    chroma_host_port: 8020,
    compose_project: "canopy-dev",
};

/// The active flavor, selected once per process (see module docs for the rules).
pub fn flavor() -> &'static Flavor {
    static ACTIVE: OnceLock<&'static Flavor> = OnceLock::new();
    ACTIVE.get_or_init(|| match std::env::var("CANOPY_FLAVOR").as_deref() {
        Ok("dev") => &DEV,
        Ok("prod") => &PROD,
        Ok(other) => {
            tracing::warn!(
                "CANOPY_FLAVOR='{}' is not 'dev' or 'prod' — falling back to build default",
                other
            );
            build_default()
        }
        Err(_) => build_default(),
    })
}

fn build_default() -> &'static Flavor {
    if cfg!(debug_assertions) {
        &DEV
    } else {
        &PROD
    }
}

/// Canopy's on-disk state root for the active flavor (SQLite, openclaw-state,
/// compose files, isolated agent state, caches — everything).
///
/// Resolution order:
///   1. `CANOPY_DATA_DIR` env override → `<override>/Canopy`. The override IS the
///      isolation mechanism (CUJ harnesses point it at a scratch dir), so the
///      subdirectory name stays flavor-independent for stable test paths.
///   2. OS data dir → `~/Library/Application Support/<flavor dir>`, i.e.
///      `Canopy` for prod and `CanopyDev` for dev.
///
/// Every module must route through this helper instead of calling
/// `dirs::data_dir()` directly — direct calls are how the 2026-08-15 incident
/// pointed a "fresh" dev instance at the production SQLite and fleet.
pub fn canopy_data_dir() -> Option<PathBuf> {
    if let Some(overridden) = std::env::var_os("CANOPY_DATA_DIR") {
        return Some(PathBuf::from(overridden).join("Canopy"));
    }
    dirs::data_dir().map(|d| d.join(flavor().data_dir_name))
}

/// Shared gateway container name for the active flavor.
pub fn gateway_container() -> &'static str {
    flavor().gateway_container
}

/// Container name for an agent's isolated container in the active flavor.
pub fn isolated_container_name(agent_id: &str) -> String {
    format!("{}{}", flavor().isolated_prefix, agent_id)
}

/// Is `name` an isolated-agent container belonging to `f`?
///
/// The dev prefix (`canopy-isolated-dev-`) extends the prod prefix
/// (`canopy-isolated-`), so a plain starts_with against the prod prefix would
/// also claim every dev container. Prod membership therefore explicitly
/// excludes dev-prefixed names.
pub fn is_isolated_container_of(f: &Flavor, name: &str) -> bool {
    if !name.starts_with(f.isolated_prefix) {
        return false;
    }
    if f.isolated_prefix == PROD.isolated_prefix && name.starts_with(DEV.isolated_prefix) {
        return false;
    }
    true
}

/// Does this Canopy-managed container belong to the ACTIVE flavor?
///
/// The `com.canopy.managed` / `com.canopy.type` labels predate flavor isolation
/// and match both flavors' containers (and pre-flavor prod containers carry no
/// flavor label at all), so ownership is decided by name. Anything that fails
/// this check is the other flavor's fleet: never adopt it, list it as ours, or
/// reconcile ("clean up") it.
pub fn container_belongs_to_active_flavor(name: &str) -> bool {
    let f = flavor();
    name == f.gateway_container || name == f.chroma_container || is_isolated_container_of(f, name)
}

/// Full gateway base URL for use from the Tauri host process.
pub fn gateway_url() -> String {
    format!("http://localhost:{}", flavor().gateway_host_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prod_values_match_shipped_literals() {
        assert_eq!(PROD.gateway_container, "canopy-gateway");
        assert_eq!(PROD.isolated_prefix, "canopy-isolated-");
        assert_eq!(PROD.gateway_host_port, 18799);
        assert_eq!(PROD.jit_port, 18802);
        assert_eq!(PROD.keychain_service, "com.canopy.app");
        assert_eq!(PROD.data_dir_name, "Canopy");
        assert_eq!(PROD.deep_link_scheme, "canopy");
    }

    #[test]
    fn dev_values_never_collide_with_prod() {
        assert_ne!(DEV.gateway_container, PROD.gateway_container);
        assert_ne!(DEV.gateway_host_port, PROD.gateway_host_port);
        assert_ne!(DEV.jit_port, PROD.jit_port);
        assert_ne!(DEV.keychain_service, PROD.keychain_service);
        assert_ne!(DEV.data_dir_name, PROD.data_dir_name);
        assert_ne!(DEV.deep_link_scheme, PROD.deep_link_scheme);
        assert_ne!(DEV.chroma_container, PROD.chroma_container);
        assert_ne!(DEV.chroma_host_port, PROD.chroma_host_port);
        assert_ne!(DEV.compose_project, PROD.compose_project);
        // Port ranges and fixed ports must be pairwise disjoint.
        let mut fixed = vec![
            PROD.gateway_host_port,
            PROD.gateway_aux_host_ports.0,
            PROD.gateway_aux_host_ports.1,
            PROD.jit_port,
            DEV.gateway_host_port,
            DEV.gateway_aux_host_ports.0,
            DEV.gateway_aux_host_ports.1,
            DEV.jit_port,
        ];
        fixed.sort_unstable();
        fixed.dedup();
        assert_eq!(fixed.len(), 8, "fixed ports must all be distinct");
        for port in &fixed {
            let in_prod_isolated = (PROD.isolated_port_base
                ..PROD.isolated_port_base + ISOLATED_PORT_RANGE)
                .contains(port);
            let in_dev_isolated = (DEV.isolated_port_base
                ..DEV.isolated_port_base + ISOLATED_PORT_RANGE)
                .contains(port);
            assert!(
                !in_prod_isolated && !in_dev_isolated,
                "fixed port {} falls inside an isolated-container port range",
                port
            );
        }
        assert!(
            DEV.isolated_port_base >= PROD.isolated_port_base + ISOLATED_PORT_RANGE
                || PROD.isolated_port_base >= DEV.isolated_port_base + ISOLATED_PORT_RANGE,
            "isolated port ranges must not overlap"
        );
    }

    #[test]
    fn dev_isolated_prefix_shares_prod_prefix_by_design() {
        // "canopy-isolated-dev-x" starts with "canopy-isolated-", so any code
        // matching containers by prefix alone would adopt the other flavor's
        // containers. Exact-name matching (isolated_container_name) is required;
        // this test documents the hazard.
        assert!(DEV.isolated_prefix.starts_with(PROD.isolated_prefix));
    }

    #[test]
    fn isolated_membership_never_crosses_flavors() {
        // Prod must not claim dev containers despite the shared prefix root…
        assert!(is_isolated_container_of(&PROD, "canopy-isolated-agent-1"));
        assert!(!is_isolated_container_of(
            &PROD,
            "canopy-isolated-dev-agent-1"
        ));
        // …and dev must not claim prod containers.
        assert!(is_isolated_container_of(
            &DEV,
            "canopy-isolated-dev-agent-1"
        ));
        assert!(!is_isolated_container_of(&DEV, "canopy-isolated-agent-1"));
        // Neither claims the other flavor's gateway or unrelated containers.
        assert!(!is_isolated_container_of(&PROD, "canopy-gateway-dev"));
        assert!(!is_isolated_container_of(&DEV, "canopy-gateway"));
    }

    #[test]
    fn active_flavor_owns_only_its_own_containers() {
        let f = flavor();
        assert!(container_belongs_to_active_flavor(f.gateway_container));
        assert!(container_belongs_to_active_flavor(f.chroma_container));
        assert!(container_belongs_to_active_flavor(
            &isolated_container_name("agent-1")
        ));
        let other = if f.name == "dev" { &PROD } else { &DEV };
        assert!(!container_belongs_to_active_flavor(other.gateway_container));
        assert!(!container_belongs_to_active_flavor(other.chroma_container));
        assert!(!container_belongs_to_active_flavor(&format!(
            "{}agent-1",
            other.isolated_prefix
        )));
    }

    #[test]
    fn isolated_container_name_uses_active_prefix() {
        let name = isolated_container_name("agent-1");
        assert!(name.ends_with("agent-1"));
        assert!(name.starts_with(flavor().isolated_prefix));
    }

    #[test]
    fn gateway_url_uses_active_host_port() {
        assert_eq!(
            gateway_url(),
            format!("http://localhost:{}", flavor().gateway_host_port)
        );
    }
}
