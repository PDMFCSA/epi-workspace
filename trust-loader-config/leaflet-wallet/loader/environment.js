export default  {
  "appName": "eLeaflet",
  "vault": "server",
  "agent": "browser",
  "system":   "any",
  "browser":  "any",
  "mode":  "autologin",
  "vaultDomain":  "vault",
  "didDomain":  "vault",
  "epiDomain": "epi",
  "enclaveType": "WalletDBEnclave",
  "sw": false,
  "pwa": false,
  "allowPinLogin": false,
  "lockFeatures": false,
  "disabledFeatures": "02, 04, 05, 06, 07, 08, 09",
  "easterEggEnabled": true,
  "epiProtocolVersion": 1,
  "appBuildVersion": "v2023.0.2"
}
/*Legend:
  vault:(server, browser)
  agent:(mobile,  browser)
  system:(iOS, Android, any)
  browser:(Chrome, Firefox, any)
  mode:(autologin,dev-autologin, secure, dev-secure, sso-direct, sso-pin)
  sw:(true, false)
  pwa:(true, false)
  lockFeatures: (true, false)
  disabledFeatures: '01, 02 ...'
    - (01 = Patient leaflet, 02 = Batch date validation checks, 03 = Show leaflet if batch unknown, 04 = Healthcare practitioner info, 05= Video source, 06 = Adverse Events reporting
07 = Anti-counterfeiting functions, 08 = Recall functions, 09 = Batch message)*/
