use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Adapter, Manager};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time;

#[derive(Serialize, Deserialize, Clone)]
pub struct BluetoothDevice {
    pub id: String,
    pub name: Option<String>,
    pub rssi: Option<i16>,
}

async fn get_central() -> Result<Adapter, String> {
    let manager = Manager::new().await.map_err(|e| format!("Failed to create Bluetooth manager: {}", e))?;
    let adapters = manager.adapters().await.map_err(|e| format!("Failed to get Bluetooth adapters: {}", e))?;
    
    if adapters.is_empty() {
        return Err("No Bluetooth adapters found on this system".to_string());
    }
    
    Ok(adapters.into_iter().nth(0).unwrap())
}

#[tauri::command]
pub async fn scan_bluetooth_devices() -> Result<Vec<BluetoothDevice>, String> {
    tracing::info!("Starting Bluetooth device scan...");
    let central = get_central().await?;
    
    central.start_scan(ScanFilter::default()).await
        .map_err(|e| format!("Failed to start Bluetooth scan: {}", e))?;
    
    // Scan for 3 seconds
    time::sleep(Duration::from_secs(3)).await;
    
    let peripherals = central.peripherals().await
        .map_err(|e| format!("Failed to get peripherals: {}", e))?;
    
    let mut devices = Vec::new();
    
    for p in peripherals {
        if let Ok(properties) = p.properties().await {
            if let Some(props) = properties {
                // Only include devices that have a name (to avoid listing hundreds of anonymous MAC addresses)
                if props.local_name.is_some() {
                    devices.push(BluetoothDevice {
                        id: p.id().to_string(),
                        name: props.local_name,
                        rssi: props.rssi,
                    });
                }
            }
        }
    }
    
    // Stop scanning
    let _ = central.stop_scan().await;
    
    // Sort by signal strength
    devices.sort_by(|a, b| b.rssi.cmp(&a.rssi));
    
    tracing::info!("Bluetooth scan found {} named devices", devices.len());
    Ok(devices)
}

#[tauri::command]
pub async fn whitelist_bluetooth_device(agent_id: String, device_id: String, device_name: String) -> Result<(), String> {
    tracing::info!("Whitelisting Bluetooth device {} for agent {}", device_id, agent_id);
    
    // We store the whitelisted device in the keychain or DB.
    // Let's use a JSON list in the keychain: `agent_{id}_bluetooth_whitelist`
    let key = format!("agent_{}_bluetooth_whitelist", agent_id);
    
    let mut current_list: Vec<BluetoothDevice> = match crate::keychain::get_secret(&key) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    
    // Check if already exists
    if !current_list.iter().any(|d| d.id == device_id) {
        current_list.push(BluetoothDevice {
            id: device_id,
            name: Some(device_name),
            rssi: None,
        });
        
        let json_str = serde_json::to_string(&current_list)
            .map_err(|e| format!("Failed to serialize whitelist: {}", e))?;
            
        crate::keychain::store_secret(&key, &json_str)
            .map_err(|e| format!("Failed to store whitelist: {}", e))?;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn get_whitelisted_bluetooth_devices(agent_id: String) -> Result<Vec<BluetoothDevice>, String> {
    let key = format!("agent_{}_bluetooth_whitelist", agent_id);
    match crate::keychain::get_secret(&key) {
        Ok(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
        Err(_) => Ok(Vec::new()),
    }
}

// The Gateway uses this command when an agent tries to read a Bluetooth device.
#[tauri::command]
pub async fn read_bluetooth_device_data(agent_id: String, device_id: String) -> Result<serde_json::Value, String> {
    tracing::info!("Agent {} requesting to read Bluetooth device {}", agent_id, device_id);
    
    // 1. Enforce Zero-Trust: Check if this agent is allowed to access this specific device
    let allowed_devices = get_whitelisted_bluetooth_devices(agent_id.clone()).await?;
    if !allowed_devices.iter().any(|d| d.id == device_id) {
        tracing::warn!("SECURITY BLOCKED: Agent {} attempted to read non-whitelisted Bluetooth device {}", agent_id, device_id);
        return Err(format!("Access Denied: You have not authorized agent {} to access device {}", agent_id, device_id));
    }
    
    // 2. Connect to the device and read characteristics
    let central = get_central().await?;
    let peripherals = central.peripherals().await
        .map_err(|e| format!("Failed to get peripherals: {}", e))?;
        
    let peripheral = peripherals.into_iter()
        .find(|p| p.id().to_string() == device_id)
        .ok_or_else(|| "Device not found in range. Ensure it is turned on.".to_string())?;
        
    let is_connected = peripheral.is_connected().await.unwrap_or(false);
    if !is_connected {
        tracing::info!("Connecting to Bluetooth device {}...", device_id);
        // Connect with timeout
        let connect_result = tokio::time::timeout(
            Duration::from_secs(5),
            peripheral.connect()
        ).await;
        
        if connect_result.is_err() || connect_result.unwrap().is_err() {
            return Err("Failed to connect to device within timeout.".to_string());
        }
    }
    
    peripheral.discover_services().await
        .map_err(|e| format!("Failed to discover services: {}", e))?;
        
    let mut data = serde_json::Map::new();
    
    for characteristic in peripheral.characteristics() {
        if characteristic.properties.contains(btleplug::api::CharPropFlags::READ) {
            // Read with timeout
            if let Ok(Ok(val)) = tokio::time::timeout(
                Duration::from_secs(2),
                peripheral.read(&characteristic)
            ).await {
                // Return hex string of value
                let hex_val = hex::encode(&val);
                data.insert(characteristic.uuid.to_string(), serde_json::Value::String(hex_val));
            }
        }
    }
    
    // Disconnect when done to save battery on the peripheral
    let _ = peripheral.disconnect().await;
    
    Ok(serde_json::Value::Object(data))
}
