//! OS-backed protection for secrets (API keys).

/// Protect a plaintext secret into its on-disk representation.
///
/// Format: `v1:<hex>` where the bytes are wrapped with the OS credential
/// protection (Windows DPAPI). On platforms without a secret store wired up
/// yet this falls back to `obf:<hex>` (obfuscated only, documented as such).
pub fn protect(plain: &str) -> Result<String, String> {
  #[cfg(target_os = "windows")]
  {
    let blob = dpapi_protect(plain.as_bytes())?;
    Ok(format!("v1:{}", bytes_to_hex(&blob)))
  }
  #[cfg(not(target_os = "windows"))]
  {
    // TODO: OS-specific secret store (Keychain / libsecret) not wired yet.
    Ok(format!("obf:{}", bytes_to_hex(plain.as_bytes())))
  }
}

/// Reverse of [`protect`]. Returns `None` on any failure (e.g. payload was
/// protected on another machine/user) so a single undecryptable key never
/// breaks loading the whole config.
pub fn unprotect(payload: &str) -> Option<String> {
  if let Some(rest) = payload.strip_prefix("v1:") {
    #[cfg(target_os = "windows")]
    {
      let bytes = hex_to_bytes(rest)?;
      let out = dpapi_unprotect(&bytes).ok()?;
      String::from_utf8(out).ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
      let _ = rest;
      None
    }
  } else if let Some(rest) = payload.strip_prefix("obf:") {
    let bytes = hex_to_bytes(rest)?;
    String::from_utf8(bytes).ok()
  } else {
    None
  }
}

fn bytes_to_hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_to_bytes(hex: &str) -> Option<Vec<u8>> {
  if hex.len() % 2 != 0 {
    return None;
  }
  (0..hex.len())
    .step_by(2)
    .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
    .collect()
}

/// Windows DPAPI encrypt (machine+user scoped, no UI prompt).
#[cfg(target_os = "windows")]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
  use windows_sys::Win32::Foundation::LocalFree;
  use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
  };

  unsafe {
    let input = CRYPT_INTEGER_BLOB {
      cbData: data.len() as u32,
      pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
      cbData: 0,
      pbData: std::ptr::null_mut(),
    };
    if CryptProtectData(
      &input,
      std::ptr::null(),
      std::ptr::null(),
      std::ptr::null(),
      std::ptr::null(),
      CRYPTPROTECT_UI_FORBIDDEN,
      &mut output,
    ) == 0
    {
      return Err(std::io::Error::last_os_error().to_string());
    }
    let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
    if !output.pbData.is_null() {
      LocalFree(output.pbData as *mut _);
    }
    Ok(out)
  }
}

/// Windows DPAPI decrypt.
#[cfg(target_os = "windows")]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
  use windows_sys::Win32::Foundation::LocalFree;
  use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptUnprotectData};

  unsafe {
    let input = CRYPT_INTEGER_BLOB {
      cbData: data.len() as u32,
      pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
      cbData: 0,
      pbData: std::ptr::null_mut(),
    };
    if CryptUnprotectData(
      &input,
      std::ptr::null_mut(),
      std::ptr::null(),
      std::ptr::null(),
      std::ptr::null(),
      0,
      &mut output,
    ) == 0
    {
      return Err(std::io::Error::last_os_error().to_string());
    }
    let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
    if !output.pbData.is_null() {
      LocalFree(output.pbData as *mut _);
    }
    Ok(out)
  }
}
