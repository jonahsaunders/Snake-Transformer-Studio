"""Everything that touches KiCad.

The rest of Snake Transformer Studio never imports kipy. It talks to this module, which
either has a live connection or does not, and says which. That boundary is
deliberate: the design tool has to stay fully usable when KiCad is not there
(during development, or when the socket drops mid-session), and the only way to
guarantee that is to keep the binding in one place behind a stable interface.

Two things about the IPC API shape the code below.

Nets cannot be created through the API. A net exists because the schematic says
so. Copper placed by a plugin therefore either joins a net that already exists
or carries none, and joining one is by name -- net codes are not stable and are
deprecated. `resolve_net` does that lookup and returns None rather than
inventing anything.

Item creation is not transactional by default. `place` wraps the whole batch in
one commit so a coil with 4,000 segments is a single Ctrl+Z, and drops the
commit on any failure so a half-built winding is never left on the board.
"""

from __future__ import annotations

import math
import os
import platform
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------
# Optional import. Absence is a supported state, not an error.
# --------------------------------------------------------------------------
KIPY_IMPORT_ERROR: Optional[str] = None
try:  # pragma: no cover - depends on the host environment
    import kipy  # type: ignore
    from kipy import KiCad  # type: ignore
    from kipy.board_types import (  # type: ignore
        ArcTrack,
        BoardLayer,
        BoardText,
        Net,
        Track,
        Via,
    )
    from kipy.geometry import Vector2  # type: ignore
    from kipy.util import from_mm, to_mm  # type: ignore

    HAVE_KIPY = True
except Exception as exc:  # pragma: no cover
    HAVE_KIPY = False
    KIPY_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"

    def from_mm(v: float) -> int:  # type: ignore
        return int(round(v * 1_000_000))

    def to_mm(v: int) -> float:  # type: ignore
        return v / 1_000_000.0


# Canonical copper layer names in stack order. KiCad's own ordering, so the
# index into this list is the index into a board's copper stack.
COPPER_ORDER: List[str] = (
    ["F.Cu"] + [f"In{i}.Cu" for i in range(1, 31)] + ["B.Cu"]
)


class LinkError(RuntimeError):
    """A request needed KiCad and KiCad was not reachable."""


@dataclass
class Placement:
    """One batch of copper to put on the board.

    Coordinates are millimetres in KiCad's own convention: +X right, +Y down,
    relative to the board origin. The web side converts out of maths
    convention before it gets here, so this module never flips a sign.
    """

    name: str = "coil"
    design_id: str = ""
    tracks: List[Dict[str, Any]] = field(default_factory=list)
    arcs: List[Dict[str, Any]] = field(default_factory=list)
    vias: List[Dict[str, Any]] = field(default_factory=list)
    pads: List[Dict[str, Any]] = field(default_factory=list)
    texts: List[Dict[str, Any]] = field(default_factory=list)
    origin: Tuple[float, float] = (0.0, 0.0)

    @classmethod
    def from_payload(cls, payload: Dict[str, Any]) -> "Placement":
        if not isinstance(payload, dict):
            raise LinkError("Placement must be an object.")
        origin = payload.get("origin") or [0.0, 0.0]
        if not isinstance(origin, (tuple, list)) or len(origin) != 2:
            raise LinkError("Placement origin must contain two finite coordinates.")
        for kind in ("tracks", "arcs", "vias", "pads", "texts"):
            if kind in payload and not isinstance(payload[kind], list):
                raise LinkError(f"Placement {kind} must be a list.")
        try:
            parsed_origin = (float(origin[0]), float(origin[1]))
        except (TypeError, ValueError, OverflowError) as exc:
            raise LinkError("Placement origin must contain two finite coordinates.") from exc
        placement = cls(
            name=str(payload.get("name") or "coil"),
            design_id=str(payload.get("designId") or ""),
            tracks=list(payload.get("tracks") or []),
            arcs=list(payload.get("arcs") or []),
            vias=list(payload.get("vias") or []),
            texts=list(payload.get("texts") or []),
            pads=list(payload.get("pads") or []),
            origin=parsed_origin,
        )
        placement.validate()
        return placement

    def validate(self) -> None:
        """Reject malformed geometry before the first KiCad mutation."""
        def number(value: Any, label: str, positive: bool = False) -> float:
            try:
                result = float(value)
            except (TypeError, ValueError, OverflowError) as exc:
                raise LinkError(f"Invalid {label}.") from exc
            if not math.isfinite(result) or abs(result) > 100000 or (positive and result <= 0):
                raise LinkError(f"Invalid {label}: use a finite {'positive ' if positive else ''}value.")
            return result

        def point(value: Any, label: str) -> None:
            if not isinstance(value, (tuple, list)) or len(value) != 2:
                raise LinkError(f"Invalid {label}: two coordinates are required.")
            for coordinate in value:
                number(coordinate, label)

        point(self.origin, "origin")
        if self.item_count() > 100000:
            raise LinkError("Placement exceeds the 100,000 item limit.")
        for kind, specs in (("track", self.tracks), ("arc", self.arcs), ("via", self.vias),
                            ("pad", self.pads), ("text", self.texts)):
            for spec in specs:
                if not isinstance(spec, dict):
                    raise LinkError(f"Invalid {kind}: each item must be an object.")
                if "net" in spec and spec["net"] is not None and not isinstance(spec["net"], str):
                    raise LinkError("Net names must be strings.")
                if kind in ("track", "arc", "pad") and spec.get("layer") not in COPPER_ORDER:
                    raise LinkError(f"Unsupported copper layer {spec.get('layer')!r}.")
                if kind in ("track", "arc"):
                    number(spec.get("width", 0.25), f"{kind} width", positive=True)
                if kind == "track":
                    pts = spec.get("pts")
                    if not isinstance(pts, list) or not 2 <= len(pts) <= 100000:
                        raise LinkError("A track needs between 2 and 100,000 points.")
                    for p in pts:
                        point(p, "track point")
                elif kind == "arc":
                    for key in ("start", "mid", "end"):
                        point(spec.get(key), f"arc {key}")
                else:
                    number(spec.get("x"), f"{kind} x")
                    number(spec.get("y"), f"{kind} y")
                if kind == "via":
                    drill = number(spec.get("drill", 0.3), "via drill", positive=True)
                    diameter = number(spec.get("diameter", 0.6), "via diameter", positive=True)
                    if drill >= diameter:
                        raise LinkError("Via diameter must exceed its drill diameter.")
                    if spec.get("layers") not in (None, ["F.Cu", "B.Cu"]) or spec.get("type") not in (None, "through"):
                        raise LinkError("Live placement supports through vias only. Use PCB export for other via spans.")
                elif kind == "pad":
                    if spec.get("layer") not in ("F.Cu", "B.Cu"):
                        raise LinkError("Surface pads require F.Cu or B.Cu.")
                    number(spec.get("w"), "pad width", positive=True)
                    number(spec.get("h"), "pad height", positive=True)
                    if spec.get("drill", 0):
                        raise LinkError("Drilled terminals must be encoded as vias, not surface pads.")
                    if spec.get("shape", "circle") not in ("rect", "circle"):
                        raise LinkError("Unsupported surface pad shape.")
                elif kind == "text" and spec.get("layer", "F.SilkS") not in ("F.SilkS", "B.SilkS", "F.Fab", "B.Fab", "Dwgs.User", "Cmts.User"):
                    raise LinkError("Unsupported text layer.")

    def item_count(self) -> int:
        return len(self.tracks) + len(self.arcs) + len(self.vias) + len(self.texts) + len(self.pads)


@dataclass
class LinkState:
    connected: bool = False
    kicad_version: str = ""
    api_version: str = ""
    board_name: str = ""
    has_board: bool = False
    error: str = ""
    kipy_available: bool = HAVE_KIPY
    import_error: str = KIPY_IMPORT_ERROR or ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "connected": self.connected,
            "kicadVersion": self.kicad_version,
            "apiVersion": self.api_version,
            "boardName": self.board_name,
            "hasBoard": self.has_board,
            "error": self.error,
            "kipyAvailable": self.kipy_available,
            "importError": self.import_error,
            "python": platform.python_version(),
            "platform": platform.system(),
        }


def _socket_path() -> Optional[str]:
    """KiCad hands the socket to the plugin through the environment.

    On Windows this is a named pipe, elsewhere a Unix socket path. kipy wants
    it prefixed, and KiCad supplies it unprefixed, so normalise here.
    """
    raw = os.environ.get("KICAD_API_SOCKET")
    if not raw:
        return None
    if "://" in raw:
        return raw
    if platform.system() == "Windows":
        return raw
    return f"ipc://{raw}"


class KiCadLink:
    """A lazily-established, self-healing connection to the running KiCad.

    Every public method is safe to call with no KiCad present; the ones that
    need it raise LinkError, which the server turns into a clean JSON error the
    UI can show without falling over.
    """

    def __init__(self, client_name: str = "Snake Transformer Studio") -> None:
        self._client_name = client_name
        self._kicad: Any = None
        self._lock = threading.RLock()
        self._last_error = ""
        self._last_attempt = 0.0

    # ---------------------------------------------------------------- connect

    def _connect(self, force: bool = False) -> Any:
        with self._lock:
            if self._kicad is not None and not force:
                return self._kicad
            if not HAVE_KIPY:
                raise LinkError(
                    "kicad-python is not installed in this environment "
                    f"({KIPY_IMPORT_ERROR})."
                )
            # Do not hammer a dead socket on every poll.
            if not force and time.time() - self._last_attempt < 1.5 and self._last_error:
                raise LinkError(self._last_error)
            self._last_attempt = time.time()
            try:
                kwargs: Dict[str, Any] = {"client_name": self._client_name, "timeout_ms": 5000}
                sock = _socket_path()
                if sock:
                    kwargs["socket_path"] = sock
                token = os.environ.get("KICAD_API_TOKEN")
                if token:
                    kwargs["kicad_token"] = token
                kicad = KiCad(**kwargs)  # type: ignore[name-defined]
                kicad.ping()
                self._kicad = kicad
                self._last_error = ""
                return kicad
            except Exception as exc:  # pragma: no cover - environment dependent
                self._kicad = None
                self._last_error = f"{type(exc).__name__}: {exc}"
                raise LinkError(self._last_error) from exc

    def _board(self, force: bool = False) -> Any:
        kicad = self._connect(force=force)
        board = kicad.get_board()
        if board is None:
            raise LinkError("No board is open in KiCad.")
        return board

    def invalidate(self) -> None:
        with self._lock:
            self._kicad = None

    # ----------------------------------------------------------------- status

    def state(self) -> LinkState:
        st = LinkState()
        if not HAVE_KIPY:
            st.error = "kicad-python not importable"
            return st
        try:
            kicad = self._connect()
        except LinkError as exc:
            st.error = str(exc)
            return st
        st.connected = True
        for attr, key in (("get_version", "kicad_version"), ("get_api_version", "api_version")):
            try:
                setattr(st, key, str(getattr(kicad, attr)()))
            except Exception:
                pass
        try:
            board = kicad.get_board()
            if board is not None:
                st.has_board = True
                st.board_name = str(getattr(board, "name", "") or "")
        except Exception as exc:
            st.error = f"{type(exc).__name__}: {exc}"
        return st

    # ---------------------------------------------------------------- context

    def board_context(self) -> Dict[str, Any]:
        """Everything the design side wants to know about the open board.

        Read defensively: a missing accessor on one KiCad point release must
        not cost us the whole context, so each block is guarded on its own and
        contributes whatever it managed to read.
        """
        board = self._board()
        ctx: Dict[str, Any] = {
            "name": str(getattr(board, "name", "") or ""),
            "copperLayers": [],
            "layerCount": 0,
            "thickness": None,
            "epsR": None,
            "copperThicknessMm": None,
            "nets": [],
            "activeLayer": None,
            "origin": [0.0, 0.0],
            "warnings": [],
        }

        # --- stack-up ------------------------------------------------------
        try:
            stackup = board.get_stackup()
            copper, dielectrics, total = _read_stackup(stackup)
            if copper:
                ctx["copperLayers"] = copper
                ctx["layerCount"] = len(copper)
                thicknesses = [c["thicknessMm"] for c in copper if c.get("thicknessMm")]
                if thicknesses:
                    ctx["copperThicknessMm"] = round(sum(thicknesses) / len(thicknesses), 5)
            if dielectrics:
                eps = [d["epsilonR"] for d in dielectrics if d.get("epsilonR")]
                if eps:
                    ctx["epsR"] = round(sum(eps) / len(eps), 4)
                ctx["dielectrics"] = dielectrics
            if total:
                ctx["thickness"] = round(total, 5)
        except Exception as exc:
            ctx["warnings"].append(f"stack-up unavailable ({type(exc).__name__})")

        # Fall back to the layer set actually present on the board when the
        # stack-up read did not produce one.
        if not ctx["copperLayers"]:
            try:
                names = []
                for nm in _enabled_copper_names(board):
                    names.append({"name": nm, "index": len(names), "thicknessMm": None})
                ctx["copperLayers"] = names
                ctx["layerCount"] = len(names)
            except Exception:
                pass

        # --- nets ----------------------------------------------------------
        try:
            nets = []
            for net in board.get_nets():
                nm = str(getattr(net, "name", "") or "")
                if nm:
                    nets.append(nm)
            ctx["nets"] = sorted(set(nets))
        except Exception as exc:
            ctx["warnings"].append(f"nets unavailable ({type(exc).__name__})")

        # --- editor state --------------------------------------------------
        try:
            ctx["activeLayer"] = _layer_name(board.get_active_layer())
        except Exception:
            pass
        try:
            sel = board.get_selection()
            ctx["selectionCount"] = len(sel)
            ctx["selectionIds"] = [_kiid(i) for i in sel][:2000]
        except Exception:
            ctx["selectionCount"] = 0
            ctx["selectionIds"] = []

        return ctx

    def board_snapshot(self) -> Dict[str, Any]:
        """Serialize live, including unsaved, board state without saving it."""
        with self._lock:
            board = self._board()
            try:
                text = board.get_as_string()
            except Exception as exc:
                raise LinkError("This KiCad API cannot serialize the board. Import a saved .kicad_pcb in Board checks instead.") from exc
            if not isinstance(text, str) or len(text) > 40_000_000:
                raise LinkError("The board snapshot is unavailable or exceeds 40 MB.")
            return {"name": str(getattr(board, "name", "") or ""), "text": text, "source": "live"}

    # ------------------------------------------------------------------ nets

    def resolve_net(self, name: Optional[str]) -> Any:
        """Return the board's Net object for `name`, or None.

        The API has no way to create a net. Placement preflight rejects an
        unknown named net so it can never silently become netless copper.
        """
        if not name:
            return None
        try:
            board = self._board()
            for net in board.get_nets():
                if str(getattr(net, "name", "")) == name:
                    return net
        except Exception:
            return None
        return None

    # ----------------------------------------------------------------- place

    def preflight(self, placement: Placement, net_name: Optional[str] = None) -> Dict[str, Any]:
        placement.validate()
        board = self._board()
        enabled = set(_enabled_copper_names(board))
        if not enabled:
            raise LinkError("Cannot verify the board's copper layers. Open a saved board or use PCB export.")
        required = {spec["layer"] for spec in placement.tracks + placement.arcs + placement.pads}
        if placement.vias:
            required.update(("F.Cu", "B.Cu"))
        missing_layers = sorted(required - enabled)
        if missing_layers:
            raise LinkError("Enable these copper layers in KiCad before placement: " + ", ".join(missing_layers))
        if any(_resolve_layer(name) is None for name in required):
            raise LinkError("The installed KiCad Python API cannot represent a required copper layer.")
        nets = set()
        for spec in placement.tracks + placement.arcs + placement.pads + placement.vias:
            name = spec.get("net") or net_name
            if name:
                if not isinstance(name, str):
                    raise LinkError("Net names must be strings.")
                nets.add(name)
        missing_nets = sorted(name for name in nets if self.resolve_net(name) is None)
        if missing_nets:
            raise LinkError("Map or create these schematic nets in KiCad before placement: " + ", ".join(missing_nets))
        return {"ok": True, "layers": sorted(required), "nets": sorted(nets),
                "items": placement.item_count(), "scope": "copper and labels only"}

    def place(self, placement: Placement, net_name: Optional[str] = None) -> Dict[str, Any]:
        """Create every item in one commit. All of it lands, or none of it."""
        self.preflight(placement, net_name=net_name)
        board = self._board()
        items: List[Any] = []
        skipped: List[str] = []

        net = self.resolve_net(net_name)
        net_cache: Dict[str, Any] = {}

        def net_for(spec: Dict[str, Any]) -> Any:
            nm = spec.get("net")
            if not nm:
                return net
            if nm not in net_cache:
                net_cache[nm] = self.resolve_net(nm)
            return net_cache[nm]

        ox, oy = placement.origin

        for spec in placement.tracks:
            layer = _resolve_layer(spec.get("layer"))
            if layer is None:
                raise LinkError(f"Unsupported copper layer {spec.get('layer')!r}.")
            width = from_mm(float(spec.get("width", 0.25)))
            pts = spec.get("pts") or []
            n = net_for(spec)
            for i in range(1, len(pts)):
                ax, ay = float(pts[i - 1][0]) + ox, float(pts[i - 1][1]) + oy
                bx, by = float(pts[i][0]) + ox, float(pts[i][1]) + oy
                if abs(ax - bx) < 1e-7 and abs(ay - by) < 1e-7:
                    continue
                t = Track()  # type: ignore[name-defined]
                t.start = Vector2.from_xy(from_mm(ax), from_mm(ay))  # type: ignore[name-defined]
                t.end = Vector2.from_xy(from_mm(bx), from_mm(by))  # type: ignore[name-defined]
                t.width = width
                t.layer = layer
                if n is not None:
                    t.net = n
                items.append(t)

        for spec in placement.arcs:
            layer = _resolve_layer(spec.get("layer"))
            if layer is None:
                raise LinkError(f"Unsupported copper layer {spec.get('layer')!r}.")
            a = ArcTrack()  # type: ignore[name-defined]
            s, m, e = spec["start"], spec["mid"], spec["end"]
            a.start = Vector2.from_xy(from_mm(float(s[0]) + ox), from_mm(float(s[1]) + oy))  # type: ignore[name-defined]
            a.mid = Vector2.from_xy(from_mm(float(m[0]) + ox), from_mm(float(m[1]) + oy))  # type: ignore[name-defined]
            a.end = Vector2.from_xy(from_mm(float(e[0]) + ox), from_mm(float(e[1]) + oy))  # type: ignore[name-defined]
            a.width = from_mm(float(spec.get("width", 0.25)))
            a.layer = layer
            n = net_for(spec)
            if n is not None:
                a.net = n
            items.append(a)

        for spec in placement.vias:
            v = Via()  # type: ignore[name-defined]
            v.position = Vector2.from_xy(  # type: ignore[name-defined]
                from_mm(float(spec["x"]) + ox), from_mm(float(spec["y"]) + oy)
            )
            try:
                v.diameter = from_mm(float(spec.get("diameter", 0.6)))
                v.drill_diameter = from_mm(float(spec.get("drill", 0.3)))
            except Exception as exc:
                raise LinkError(f"The installed KiCad API could not set via dimensions ({type(exc).__name__}).") from exc
            n = net_for(spec)
            if n is not None:
                v.net = n
            items.append(v)

        if placement.pads:
            # Pads must live inside a footprint. Never turn an SMD antenna
            # plate or transformer terminal into a through via.
            from kipy.board_types import FootprintInstance, Pad, PadType, PadStackShape
            fp = FootprintInstance()
            fp.layer = BoardLayer.BL_F_Cu
            fp.reference_field.text.value = placement.name
            fp.value_field.text.value = placement.name
            for spec in placement.pads:
                layer = _resolve_layer(spec.get("layer"))
                if layer not in (BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu):
                    raise LinkError("Surface pads require F.Cu or B.Cu.")
                w, h = float(spec["w"]), float(spec["h"])
                x, y = float(spec["x"]), float(spec["y"])
                if not all(math.isfinite(v) for v in (w, h, x, y)) or min(w, h) <= 0:
                    raise LinkError("Invalid surface pad dimensions.")
                p = Pad()
                p.pad_type = PadType.PT_SMD
                p.number = str(spec.get("number", ""))
                p.position = Vector2.from_xy(from_mm(x), from_mm(y))
                p.padstack.layers = [layer]
                # A NORMAL padstack defines the shape once, on its front entry,
                # and applies it to each enabled layer, including a back pad.
                shape = p.padstack.copper_layers[0]
                shape.shape = PadStackShape.PSS_RECTANGLE if spec.get("shape") == "rect" else PadStackShape.PSS_CIRCLE
                shape.size = Vector2.from_xy(from_mm(w), from_mm(h))
                if spec.get("mask", True):
                    p.padstack.layers = [layer, BoardLayer.BL_F_Mask if layer == BoardLayer.BL_F_Cu else BoardLayer.BL_B_Mask]
                n = net_for(spec)
                if n is not None:
                    p.net = n
                fp.definition.add_item(p)
            fp.position = Vector2.from_xy(from_mm(ox), from_mm(oy))
            items.append(fp)

        for spec in placement.texts:
            layer = _resolve_layer(spec.get("layer") or "F.SilkS")
            if layer is None:
                raise LinkError(f"Unsupported text layer {spec.get('layer')!r}.")
            t = BoardText()  # type: ignore[name-defined]
            t.position = Vector2.from_xy(  # type: ignore[name-defined]
                from_mm(float(spec["x"]) + ox), from_mm(float(spec["y"]) + oy)
            )
            t.value = str(spec.get("value", ""))
            t.layer = layer
            items.append(t)

        if not items:
            return {"created": 0, "ids": [], "skipped": skipped}

        commit = None
        try:
            commit = board.begin_commit()
        except Exception as exc:
            raise LinkError("KiCad could not begin an undoable placement; no copper was changed.") from exc
        if commit is None:
            raise LinkError("KiCad did not return an undoable commit; no copper was changed.")

        try:
            created = board.create_items(items)
            if len(created or []) != len(items):
                raise LinkError("KiCad created only part of the requested placement.")
        except Exception as exc:
            if commit is not None:
                try:
                    board.drop_commit(commit)
                except Exception:
                    pass
            raise LinkError(f"KiCad rejected the placement: {type(exc).__name__}: {exc}") from exc

        if commit is not None:
            try:
                board.push_commit(commit, f"Snake Transformer Studio: place {placement.name}")
            except Exception as exc:
                try:
                    board.drop_commit(commit)
                except Exception as rollback_error:
                    raise LinkError("KiCad could not commit or cancel the placement. Inspect the board before continuing.") from rollback_error
                raise LinkError("KiCad could not commit the placement; the pending commit was cancelled.") from exc

        ids = [_kiid(c) for c in (created or [])]
        return {"created": len(created or []), "ids": [i for i in ids if i], "skipped": skipped}

    # ---------------------------------------------------------------- delete

    def remove_ids(self, ids: Sequence[str]) -> Dict[str, Any]:
        board = self._board()
        if not ids:
            return {"removed": 0}
        wanted = set(ids)
        victims = []
        try:
            for item in board.get_tracks():
                if _kiid(item) in wanted:
                    victims.append(item)
            for item in board.get_vias():
                if _kiid(item) in wanted:
                    victims.append(item)
            for item in board.get_footprints():
                if _kiid(item) in wanted:
                    victims.append(item)
        except Exception as exc:
            raise LinkError(f"could not enumerate board items: {exc}") from exc
        if not victims:
            return {"removed": 0}
        commit = None
        try:
            commit = board.begin_commit()
        except Exception:
            commit = None
        try:
            board.remove_items(victims)
        except Exception as exc:
            if commit is not None:
                try:
                    board.drop_commit(commit)
                except Exception:
                    pass
            raise LinkError(f"could not remove items: {exc}") from exc
        if commit is not None:
            try:
                board.push_commit(commit, "Snake Transformer Studio: remove placement")
            except Exception:
                pass
        return {"removed": len(victims)}

    # --------------------------------------------------------------- project

    def project_dir(self) -> Optional[str]:
        """Directory of the open project, for writing a footprint library."""
        try:
            board = self._board()
        except LinkError:
            return None
        for getter in ("document", "get_project"):
            try:
                obj = getattr(board, getter)
                obj = obj() if callable(obj) else obj
            except Exception:
                continue
            for attr in ("board_filename", "project_name", "name", "path"):
                try:
                    val = getattr(obj, attr, None)
                    if isinstance(val, str) and os.sep in val:
                        return os.path.dirname(val)
                except Exception:
                    continue
        return None

    def settings_dir(self) -> Optional[str]:
        try:
            kicad = self._connect()
            return kicad.get_plugin_settings_path("com.jonahsaunders.snaketransformerstudio")
        except Exception:
            return None

    def select(self, ids: Sequence[str]) -> None:
        try:
            board = self._board()
            board.clear_selection()
        except Exception:
            return
        if not ids:
            return
        wanted = set(ids)
        try:
            hits = [i for i in list(board.get_tracks()) + list(board.get_vias()) + list(board.get_footprints()) if _kiid(i) in wanted]
            if hits:
                board.add_to_selection(hits)
        except Exception:
            pass

    def refill_zones(self) -> None:
        try:
            self._board().refill_zones(block=False)
        except Exception:
            pass


# --------------------------------------------------------------------------
# Layer helpers. Name-driven, because canonical names are stable across
# releases and the enum member spellings historically have not been.
# --------------------------------------------------------------------------

_LAYER_CACHE: Dict[str, Any] = {}


def _enabled_copper_names(board: Any) -> List[str]:
    """Read real enabled layers. Never substitute all 32 possible copper layers."""
    try:
        names = {_layer_name(layer) for layer in board.get_enabled_layers()}
        result = [name for name in COPPER_ORDER if name in names]
        if result:
            return result
    except Exception:
        pass
    try:
        copper, _, _ = _read_stackup(board.get_stackup())
        names = {entry["name"] for entry in copper}
        result = [name for name in COPPER_ORDER if name in names]
        if result:
            return result
    except Exception:
        pass
    try:
        count = int(board.get_copper_layer_count())
        if 2 <= count <= 32 and count % 2 == 0:
            return ["F.Cu"] + [f"In{i}.Cu" for i in range(1, count - 1)] + ["B.Cu"]
    except Exception:
        pass
    return []


def _resolve_layer(name: Optional[str]) -> Any:
    if not name:
        return None
    if name in _LAYER_CACHE:
        return _LAYER_CACHE[name]
    if not HAVE_KIPY:
        return None
    value = None
    try:
        from kipy.util.board_layer import layer_from_canonical_name  # type: ignore

        value = layer_from_canonical_name(name)
    except Exception:
        value = None
    if value is None:
        # Enum spelling: "In1.Cu" -> BL_In1_Cu
        candidate = "BL_" + name.replace(".", "_")
        value = getattr(BoardLayer, candidate, None)  # type: ignore[name-defined]
    if value is None:
        alt = {"F.SilkS": "F_SilkS", "B.SilkS": "B_SilkS"}.get(name)
        if alt:
            value = getattr(BoardLayer, "BL_" + alt, None)  # type: ignore[name-defined]
    if value is not None:
        _LAYER_CACHE[name] = value
    return value


def _layer_name(layer: Any) -> Optional[str]:
    if layer is None:
        return None
    try:
        from kipy.util.board_layer import canonical_name  # type: ignore

        return str(canonical_name(layer))
    except Exception:
        pass
    name = getattr(layer, "name", None)
    if isinstance(name, str):
        return name[3:].replace("_", ".") if name.startswith("BL_") else name
    return None


def _iter_copper_layers() -> Iterable[Any]:
    try:
        from kipy.util.board_layer import iter_copper_layers  # type: ignore

        return list(iter_copper_layers())
    except Exception:
        return []


def _kiid(item: Any) -> str:
    for attr in ("id", "kiid"):
        val = getattr(item, attr, None)
        if val is None:
            continue
        try:
            inner = getattr(val, "value", None)
            return str(inner if inner is not None else val)
        except Exception:
            continue
    return ""


def _read_stackup(stackup: Any) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], float]:
    """Pull copper layers, dielectrics and total thickness out of a stack-up.

    The stack-up proto has been through more than one shape; rather than bind
    to one, walk whatever iterable of layers it exposes and read by duck type.
    """
    copper: List[Dict[str, Any]] = []
    dielectrics: List[Dict[str, Any]] = []
    total = 0.0
    heights_known = True

    layers = None
    for attr in ("layers", "layer", "stackup_layers"):
        cand = getattr(stackup, attr, None)
        if cand is not None:
            try:
                layers = list(cand)
                break
            except TypeError:
                continue
    if layers is None:
        return copper, dielectrics, total

    for entry in layers:
        if getattr(entry, "enabled", None) is False:
            continue
        thickness = None
        for attr in ("thickness", "thickness_nm"):
            raw = getattr(entry, attr, None)
            if isinstance(raw, (int, float)) and raw:
                thickness = to_mm(int(raw))
                break
        if not thickness:
            heights_known = False
        if thickness:
            total += thickness

        name = _layer_name(getattr(entry, "layer", None)) or str(getattr(entry, "name", "") or "")
        typ = str(getattr(entry, "type", "") or "")

        if name and name.endswith(".Cu"):
            copper.append(
                {
                    "name": name,
                    "index": len(copper),
                    "thicknessMm": round(thickness, 6) if thickness else None,
                    "centerHeightMm": round(total - thickness / 2, 6) if thickness else None,
                }
            )
            continue

        eps = None
        loss = None
        material = ""
        sublayers = getattr(entry, "dielectric", None)
        probe = [entry] if sublayers is None else list(getattr(sublayers, "layers", []) or [sublayers])
        for sub in probe:
            for attr in ("epsilon_r", "epsilonr", "eps_r"):
                raw = getattr(sub, attr, None)
                if isinstance(raw, (int, float)) and raw > 0:
                    eps = float(raw)
                    break
            for attr in ("loss_tangent", "loss_tan"):
                raw = getattr(sub, attr, None)
                if isinstance(raw, (int, float)) and raw > 0:
                    loss = float(raw)
                    break
            raw = getattr(sub, "material", None)
            if isinstance(raw, str) and raw:
                material = raw
        if eps or (typ and "diel" in typ.lower()):
            dielectrics.append(
                {
                    "name": name or material or "dielectric",
                    "epsilonR": eps,
                    "lossTangent": loss,
                    "thicknessMm": round(thickness, 6) if thickness else None,
                    "material": material,
                }
            )

    if not heights_known:
        for layer in copper:
            layer.pop("centerHeightMm", None)
    return copper, dielectrics, round(total, 6)
