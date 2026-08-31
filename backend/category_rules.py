import re

CATEGORY_KEYWORDS = {
    'wallets': [
        r'\bwallets?\b', r'\bpurses?\b', r'\bcardholders?\b', r'\bbillfolds?\b',
    ],
    'keys': [
        r'\bkeys?\b', r'\bkeychains?\b', r'\bkey\s+rings?\b', r'\bfobs?\b',
    ],
    'bags': [
        r'\bbags?\b', r'\bbackpacks?\b', r'\brucksacks?\b', r'\bsatchels?\b',
        r'\bduffels?\b', r'\btotes?\b', r'\bhandbags?\b', r'\bluggage\b',
        r'\bsuitcases?\b', r'\bpouches?\b',
    ],
    'electronics': [
        r'\bphones?\b', r'\biphones?\b', r'\bsamsungs?\b', r'\bandroids?\b',
        r'\blaptops?\b', r'\bmacbooks?\b', r'\bcomputers?\b', r'\btablets?\b',
        r'\bipads?\b', r'\bearbuds?\b', r'\bearphones?\b', r'\bheadphones?\b',
        r'\bchargers?\b', r'\bcameras?\b', r'\bsmartwatches?\b', r'\bkindles?\b',
        r'\bpendrives?\b', r'\bflash\s+drives?\b', r'\bcalculators?\b',
    ],
    'id-card': [
        r'\bid\s+cards?\b', r'\bstudent\s+ids?\b', r'\bcampus\s+ids?\b',
        r'\bschool\s+ids?\b', r'\bcollege\s+ids?\b', r'\bidentity\s+cards?\b',
        r'\bidentification\b', r"\bdriver'?s?\s+licen[cs]es?\b",
        r'\bpassports?\b', r'\blibrary\s+cards?\b', r'\bmetro\s+cards?\b',
    ],
    'books': [
        r'\bbooks?\b', r'\btextbooks?\b', r'\bnotebooks?\b', r'\bjournals?\b',
        r'\bnovels?\b', r'\bbinders?\b', r'\bmagazines?\b', r'\bplanners?\b',
    ],
    'clothing': [
        r'\bjackets?\b', r'\bhoodies?\b', r'\bsweaters?\b', r'\bsweatshirts?\b',
        r'\bshirts?\b', r'\bscarves\b', r'\bscarfs\b', r'\bgloves?\b',
        r'\bmittens\b', r'\bcaps?\b', r'\bhats?\b', r'\bcoats?\b', r'\bjeans?\b',
    ],
}

CATEGORY_LABELS = {
    'electronics': 'Electronics',
    'id-card': 'ID Cards',
    'bags': 'Bags',
    'wallets': 'Wallets',
    'books': 'Books',
    'keys': 'Keys',
    'clothing': 'Clothing',
    'other': 'Other',
}


def _count_matches(text, patterns):
    total = 0
    for pattern in patterns:
        total += len(re.findall(pattern, text))
    return total


def validate_category(title, description, category):
    title_text = ' '.join(str(title or '').lower().split())
    desc_text = ' '.join(str(description or '').lower().split())
    combined = f'{title_text} {desc_text}'

    base = {
        'valid': True,
        'suggested_category': None,
        'confidence': 0.0,
        'message': '',
    }

    if category not in CATEGORY_LABELS or category == 'other':
        return base
    if not combined.strip():
        return base

    scores = {}
    for cat, patterns in CATEGORY_KEYWORDS.items():
        scores[cat] = 2 * _count_matches(title_text, patterns) + _count_matches(desc_text, patterns)

    selected_score = scores.get(category, 0)
    rivals = {cat: score for cat, score in scores.items() if cat != category}
    best_cat = max(rivals, key=lambda c: (rivals[c], c))
    best_score = rivals[best_cat]

    strong_mismatch = best_score >= 2 and best_score >= selected_score + 2

    if not strong_mismatch:
        base['confidence'] = round(min(0.9, 0.4 + 0.1 * selected_score), 2)
        return base

    confidence = min(0.95, round(0.5 + 0.15 * best_score - 0.05 * selected_score, 2))
    label = CATEGORY_LABELS[best_cat]
    return {
        'valid': False,
        'suggested_category': best_cat,
        'confidence': confidence,
        'message': f'Your selected category may not match this item. Did you mean {label}?',
    }
