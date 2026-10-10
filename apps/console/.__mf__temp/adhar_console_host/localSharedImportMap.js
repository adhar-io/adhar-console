
// Windows temporarily needs this file, https://github.com/module-federation/vite/issues/68

    import {loadShare} from "@module-federation/runtime";
    const importMap = {
      
        "@tanstack/react-query": async () => {
          let pkg = await import("__mf__virtual/__mfe_internal__adhar_console_host__prebuild___mf_0_tanstack_mf_1_react_mf_2_query__prebuild__.js");
            return pkg;
        }
      ,
        "@tanstack/react-router": async () => {
          let pkg = await import("__mf__virtual/__mfe_internal__adhar_console_host__prebuild___mf_0_tanstack_mf_1_react_mf_2_router__prebuild__.js");
            return pkg;
        }
      ,
        "react": async () => {
          let pkg = await import("__mf__virtual/__mfe_internal__adhar_console_host__prebuild__react__prebuild__.js");
            return pkg;
        }
      ,
        "react-dom": async () => {
          let pkg = await import("__mf__virtual/__mfe_internal__adhar_console_host__prebuild__react_mf_2_dom__prebuild__.js");
            return pkg;
        }
      
    }
      const usedShared = {
      
          "@tanstack/react-query": {
            name: "@tanstack/react-query",
            version: "5.99.1",
            scope: ["default"],
            loaded: false,
            from: "__mfe_internal__adhar_console_host",
            async get () {
              if (false) {
                throw new Error(`[Module Federation] Shared module '${"@tanstack/react-query"}' must be provided by host`);
              }
              usedShared["@tanstack/react-query"].loaded = true
              const {"@tanstack/react-query": pkgDynamicImport} = importMap
              const res = await pkgDynamicImport()
              const exportModule = false && "@tanstack/react-query" === "react"
                ? (res?.default ?? res)
                : {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: true,
              requiredVersion: "^5.99.1",
              
            }
          }
        ,
          "@tanstack/react-router": {
            name: "@tanstack/react-router",
            version: "1.168.23",
            scope: ["default"],
            loaded: false,
            from: "__mfe_internal__adhar_console_host",
            async get () {
              if (false) {
                throw new Error(`[Module Federation] Shared module '${"@tanstack/react-router"}' must be provided by host`);
              }
              usedShared["@tanstack/react-router"].loaded = true
              const {"@tanstack/react-router": pkgDynamicImport} = importMap
              const res = await pkgDynamicImport()
              const exportModule = false && "@tanstack/react-router" === "react"
                ? (res?.default ?? res)
                : {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: true,
              requiredVersion: "^1.168.23",
              
            }
          }
        ,
          "react": {
            name: "react",
            version: "19.2.0",
            scope: ["default"],
            loaded: false,
            from: "__mfe_internal__adhar_console_host",
            async get () {
              if (false) {
                throw new Error(`[Module Federation] Shared module '${"react"}' must be provided by host`);
              }
              usedShared["react"].loaded = true
              const {"react": pkgDynamicImport} = importMap
              const res = await pkgDynamicImport()
              const exportModule = false && "react" === "react"
                ? (res?.default ?? res)
                : {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: true,
              requiredVersion: "^19.2.0",
              
            }
          }
        ,
          "react-dom": {
            name: "react-dom",
            version: "19.2.0",
            scope: ["default"],
            loaded: false,
            from: "__mfe_internal__adhar_console_host",
            async get () {
              if (false) {
                throw new Error(`[Module Federation] Shared module '${"react-dom"}' must be provided by host`);
              }
              usedShared["react-dom"].loaded = true
              const {"react-dom": pkgDynamicImport} = importMap
              const res = await pkgDynamicImport()
              const exportModule = false && "react-dom" === "react"
                ? (res?.default ?? res)
                : {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: true,
              requiredVersion: "^19.2.0",
              
            }
          }
        
    }
      const usedRemotes = [
                {
                  entryGlobalName: "define",
                  name: "define",
                  type: "module",
                  entry: "http://localhost:5101/mf/remoteEntry.js",
                  shareScope: "default",
                }
          ,
                {
                  entryGlobalName: "design",
                  name: "design",
                  type: "module",
                  entry: "http://localhost:5102/mf/remoteEntry.js",
                  shareScope: "default",
                }
          ,
                {
                  entryGlobalName: "develop",
                  name: "develop",
                  type: "module",
                  entry: "http://localhost:5103/mf/remoteEntry.js",
                  shareScope: "default",
                }
          ,
                {
                  entryGlobalName: "deliver",
                  name: "deliver",
                  type: "module",
                  entry: "http://localhost:5104/mf/remoteEntry.js",
                  shareScope: "default",
                }
          ,
                {
                  entryGlobalName: "discover",
                  name: "discover",
                  type: "module",
                  entry: "http://localhost:5105/mf/remoteEntry.js",
                  shareScope: "default",
                }
          ,
                {
                  entryGlobalName: "decide",
                  name: "decide",
                  type: "module",
                  entry: "http://localhost:5106/mf/remoteEntry.js",
                  shareScope: "default",
                }
          ,
                {
                  entryGlobalName: "platform",
                  name: "platform",
                  type: "module",
                  entry: "http://localhost:5107/mf/remoteEntry.js",
                  shareScope: "default",
                }
          ,
                {
                  entryGlobalName: "workspace",
                  name: "workspace",
                  type: "module",
                  entry: "http://localhost:5108/mf/remoteEntry.js",
                  shareScope: "default",
                }
          ,
                {
                  entryGlobalName: "builder",
                  name: "builder",
                  type: "module",
                  entry: "http://localhost:5174/mf/remoteEntry.js",
                  shareScope: "default",
                }
          
      ]
      export {
        usedShared,
        usedRemotes
      }
      