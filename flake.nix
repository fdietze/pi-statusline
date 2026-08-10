{
  description = "Development environment for pi-statusline";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          nativeBuildInputs = [
            pkgs.nodejs_24
            (pkgs.lib.hiPrio pkgs.bashInteractive)
          ];

          # The host Pi wrapper exports its own Nix package root. Node-based
          # tests must instead resolve themes from their local dev dependency.
          shellHook = ''
            unset PI_PACKAGE_DIR
          '';
        };
      }
    );
}
