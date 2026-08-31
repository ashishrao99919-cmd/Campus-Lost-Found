import re

ACCESSORY_WORDS = (
    r"(?:keys?|keyrings?|keychains?|locks?|helmets?|chains?|pumps?|bells?|lights?|"
    r"seats?|saddles?|pedals?|tyres?|tires?|inner\s+tubes?|tubes?|brakes?|gears?|"
    r"baskets?|mirrors?|number\s+plates?|licence\s+plates?|license\s+plates?|"
    r"handlebars?|spokes?|frames?|covers?|racks?|batteries?|chargers?)"
)

BICYCLE_RE = re.compile(r"\b(?:bicycles?|cycles?|bikes?|mtbs?)\b")

VEHICLE_CORE_RE = re.compile(
    r"\b(?:cars?|suvs?|minivans?|vans?|trucks?|pickups?|lorries|buses?|coaches?|"
    r"jeeps?|sedans?|hatchbacks?|coupes?|limousines?|tractors?|campers?|"
    r"rickshaws?|e\s*-?\s*rickshaws?|auto\s*-?\s*rickshaws?|tempos?|"
    r"motorcycles?|motor\s*bikes?|scooters?|scootys?|mopeds?)\b",
    re.IGNORECASE,
)

_BRAND_ALTERNATION = (
    r"(?:hondas?|suzukis?|yamahas?|kawasakis?|harleys?|ducatis?|royal\s+enfields?|"
    r"bajajs?|mahindras?|toyotas?|hyundais?|fords?|chevrolets?|ferraris?|"
    r"lamborghinis?|bmws?|mercedes(?:\s+benz)?)"
)
BRAND_RE = re.compile(r"\b" + _BRAND_ALTERNATION + r"\b", re.IGNORECASE)

LIVING_RE = re.compile(
    r"\b(?:pets?|puppies?|puppy|pups?|dogs?|doggos?|kittens?|kitties|cats?|"
    r"birds?|parrots?|parakeets?|pigeons?|sparrows?|crows?|fishes?|aquariums?|"
    r"turtles?|tortoises?|snakes?|lizards?|iguanas?|hamsters?|rabbits?|bunnies?|"
    r"goats?|sheep|lambs?|calves?|cows?|bulls?|chickens?|hens?|roosters?|ducks?|"
    r"insects?|ants?|bees?|spiders?|scorpions?|"
    r"plants?|saplings?|seedlings?|bonsais?|trees?|flowers?|bouquets?|shrubs?|cacti|cactuses?|ferns?)\b",
    re.IGNORECASE,
)

WEAPONS_RE = re.compile(
    r"\b(?:guns?|handguns?|shotguns?|airguns?|firearms?|pistols?|revolvers?|"
    r"rifles?|ammunitions?|ammo|bullets?|bombs?|explosives?|grenades?|"
    r"dynamite|detonators?|knife|knives|daggers?|bayonets?|tasers?|stun\s+guns?)\b",
    re.IGNORECASE,
)

REASON_VEHICLE = "Vehicles other than bicycles are not allowed on Campus Lost & Found."
REASON_LIVING = "Living things (pets, animals, or plants) cannot be listed on Campus Lost & Found."
REASON_WEAPON = "Weapons and dangerous items are not allowed on Campus Lost & Found."


def _neutralize(pattern, text):
    previous = None
    while previous != text:
        previous = text
        text = pattern.sub(" ", text)
    return text


def _strip_accessory_phrases(text):
    """Remove vehicle mentions that only describe an accessory ('car keys',
    'keys to my bike', 'Honda cycle lock') so they are never treated as a
    vehicle listing."""
    vehicles = (
        r"(?:cars?|vans?|trucks?|buses?|jeeps?|motorcycles?|scooters?|mopeds?|"
        r"rickshaws?|lorries|autos?|bicycles?|cycles?|bikes?)"
    )
    brands = "(?:" + _BRAND_ALTERNATION + ")"
    forward = re.compile(
        brands + r"?\s*" + vehicles + r"\s+(?:\w+\s+){0,4}?" + ACCESSORY_WORDS,
        re.IGNORECASE,
    )
    backward = re.compile(
        ACCESSORY_WORDS + r"\s+(?:\w+\s+){0,4}?" + vehicles + r"(?:\s+" + brands + r")?",
        re.IGNORECASE,
    )
    text = _neutralize(forward, text)
    return _neutralize(backward, text)


def validate_listing_content(title, description, category=""):
    combined = f"{title or ''} {description or ''} {category or ''}".lower()

    cleaned = re.sub(r"[,;:.!?]", " ", combined)
    cleaned = _strip_accessory_phrases(cleaned)
    cleaned = BICYCLE_RE.sub(" ", cleaned)

    if VEHICLE_CORE_RE.search(cleaned) or BRAND_RE.search(cleaned):
        return {"allowed": False, "reason": REASON_VEHICLE}

    if LIVING_RE.search(combined):
        return {"allowed": False, "reason": REASON_LIVING}

    if WEAPONS_RE.search(combined):
        return {"allowed": False, "reason": REASON_WEAPON}

    return {"allowed": True}
