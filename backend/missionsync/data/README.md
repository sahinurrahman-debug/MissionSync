# Bundled data

`xbd_seeds.json` is a snapshot of 20 **real label files** from the xBD building-damage
dataset (xView2), reduced to the fields MissionSync needs (disaster type, location, per-building
damage grades). It lets the API start instantly and offline, with no Kaggle credentials.

* Dataset: Gupta et al., *xBD: A Dataset for Assessing Building Damage from Satellite Imagery* (2019), <https://xview2.org>
* Licence: **CC BY-NC-SA 4.0** — attribution required, **non-commercial use only**, share-alike.
* Rebuild it (or pull the live dataset) with `scripts/build_xbd_snapshot.py`, or set `XBD_SOURCE=kaggle`.

MissionSync uses it for a training/demo drill, not for real emergency response.
