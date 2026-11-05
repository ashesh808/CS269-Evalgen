{
  description = "EvalGen";
  inputs.nixpkgs.url = "github:nixos/nixpkgs/ea9e3ef341e11c193537f674f821a99f9f436729";
  outputs = { self, nixpkgs }:
  let
    pkgs = import nixpkgs { system = "x86_64-linux"; config.allowUnfree = true; };
    lib = nixpkgs.lib;
  in {
    devShells.x86_64-linux.default = pkgs.mkShell {
      packages = with pkgs; [
        python3
        uv
        ruff
        black
        pyright
        git
      ];
      DEV_SHELL = "EvalGen";
      LD_LIBRARY_PATH = lib.makeLibraryPath (with pkgs; [ stdenv.cc.cc.lib zlib ]);
      shellHook = ''
        if [ -d .venv ]; then
          export VIRTUAL_ENV="$PWD/.venv"
          export PATH="$PWD/.venv/bin:$PATH"
        fi
        [[ $- == *i* ]] && exec zsh
      '';
    };
  };
}
