-- Additive RMA workspace. Amounts are integer piastres; no historical order rewrites.
CREATE TABLE IF NOT EXISTS rma_policy (
 id INTEGER PRIMARY KEY CHECK(id=1), days INTEGER NOT NULL DEFAULT 14 CHECK(days BETWEEN 14 AND 365),
 defect_days INTEGER NOT NULL DEFAULT 30 CHECK(defect_days BETWEEN 30 AND 365), auto_approve INTEGER NOT NULL DEFAULT 1 CHECK(auto_approve IN(0,1)),
 goodwill_fee INTEGER NOT NULL DEFAULT 0 CHECK(goodwill_fee BETWEEN 0 AND 100000),
 courier TEXT NOT NULL DEFAULT 'manual' CHECK(courier IN('manual','bosta','shipblu','aramex')),
 instructions_en TEXT NOT NULL DEFAULT 'Keep the items and packaging ready. We will show pickup details here.',
 instructions_ar TEXT NOT NULL DEFAULT 'جهّز المنتجات والتغليف. ستظهر تفاصيل الاستلام هنا.', updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);
INSERT OR IGNORE INTO rma_policy(id) VALUES(1);
CREATE TABLE IF NOT EXISTS rma_cases (
 id TEXT PRIMARY KEY, digest TEXT NOT NULL, source_key TEXT NOT NULL, order_reference TEXT NOT NULL,
 email TEXT NOT NULL COLLATE NOCASE, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
 kind TEXT NOT NULL CHECK(kind IN('refund','exchange','credit')), reason TEXT NOT NULL, reason_note TEXT NOT NULL,
 language TEXT NOT NULL CHECK(language IN('en','ar')), state TEXT NOT NULL DEFAULT 'requested' CHECK(state IN('requested','approved','received','completed','declined','cancelled')),
 eligibility TEXT NOT NULL, statutory INTEGER NOT NULL CHECK(statutory IN(0,1)),
 item_value INTEGER NOT NULL CHECK(item_value>=0), shipping_refund INTEGER NOT NULL DEFAULT 0 CHECK(shipping_refund>=0),
 replacement_value INTEGER NOT NULL DEFAULT 0 CHECK(replacement_value>=0), fee INTEGER NOT NULL DEFAULT 0 CHECK(fee>=0),
 settlement INTEGER NOT NULL, payment_verified INTEGER NOT NULL DEFAULT 0 CHECK(payment_verified IN(0,1)),
 message TEXT NOT NULL DEFAULT '', reference TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()), updated_at INTEGER NOT NULL DEFAULT(unixepoch()),
 CHECK(statutory=0 OR fee=0)
);
CREATE INDEX IF NOT EXISTS rma_cases_order ON rma_cases(source_key,state);
CREATE INDEX IF NOT EXISTS rma_cases_customer ON rma_cases(email,created_at DESC);
CREATE TABLE IF NOT EXISTS rma_lines (
 case_id TEXT NOT NULL REFERENCES rma_cases(id), line_key TEXT NOT NULL, source_key TEXT NOT NULL,
 variant_id TEXT REFERENCES variants(id), title TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 25),
 purchased INTEGER NOT NULL CHECK(purchased>=quantity), value INTEGER NOT NULL CHECK(value>=0),
 replacement_id TEXT REFERENCES variants(id), replacement_title TEXT NOT NULL DEFAULT '', replacement_price INTEGER NOT NULL DEFAULT 0,
 unit_cost INTEGER, replacement_cost INTEGER, restocked INTEGER NOT NULL DEFAULT 0 CHECK(restocked IN(0,1)),
 PRIMARY KEY(case_id,line_key)
);
CREATE TRIGGER IF NOT EXISTS rma_quantity_guard BEFORE INSERT ON rma_lines BEGIN
 SELECT CASE WHEN NEW.quantity + coalesce((SELECT sum(l.quantity) FROM rma_lines l JOIN rma_cases c ON c.id=l.case_id WHERE l.source_key=NEW.source_key AND l.line_key=NEW.line_key AND c.state NOT IN('declined','cancelled')),0) +
 coalesce((SELECT sum(quantity) FROM order_returns WHERE 'website:'||order_id=NEW.source_key AND variant_id=NEW.line_key AND state NOT IN('declined','cancelled')),0)>NEW.purchased
 THEN RAISE(ABORT,'Return quantity already requested') END;
END;
CREATE TRIGGER IF NOT EXISTS rma_legacy_quantity_guard BEFORE INSERT ON order_returns BEGIN
 SELECT CASE WHEN NEW.quantity + coalesce((SELECT sum(l.quantity) FROM rma_lines l JOIN rma_cases c ON c.id=l.case_id WHERE l.source_key='website:'||NEW.order_id AND l.line_key=NEW.variant_id AND c.state NOT IN('declined','cancelled')),0) +
 coalesce((SELECT sum(quantity) FROM order_returns WHERE order_id=NEW.order_id AND variant_id=NEW.variant_id AND state NOT IN('declined','cancelled')),0)>(SELECT quantity FROM order_items WHERE order_id=NEW.order_id AND variant_id=NEW.variant_id)
 THEN RAISE(ABORT,'Return quantity already requested') END;
END;
CREATE TABLE IF NOT EXISTS rma_events (
 id TEXT PRIMARY KEY,case_id TEXT REFERENCES rma_cases(id),actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TRIGGER IF NOT EXISTS rma_event_immutable BEFORE UPDATE ON rma_events BEGIN SELECT RAISE(ABORT,'Activity history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS rma_event_no_delete BEFORE DELETE ON rma_events BEGIN SELECT RAISE(ABORT,'Activity history is immutable'); END;
CREATE TABLE IF NOT EXISTS rma_mail (
 event_id TEXT PRIMARY KEY REFERENCES rma_events(id),recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,sent_at INTEGER,lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rma_photos (
 id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES rma_cases(id),media_key TEXT NOT NULL UNIQUE,mime TEXT NOT NULL,size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rma_operations (
 id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES rma_cases(id),kind TEXT NOT NULL,provider TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('running','succeeded','review')),reference TEXT NOT NULL DEFAULT '',detail TEXT NOT NULL DEFAULT '',
 amount INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL DEFAULT(unixepoch()), UNIQUE(case_id,kind)
);
CREATE UNIQUE INDEX IF NOT EXISTS rma_operation_reference ON rma_operations(provider,kind,reference) WHERE reference<>'';
CREATE TABLE IF NOT EXISTS rma_shipments (
 case_id TEXT NOT NULL REFERENCES rma_cases(id),direction TEXT NOT NULL CHECK(direction IN('return','replacement')),
 provider TEXT NOT NULL,provider_id TEXT NOT NULL DEFAULT '',tracking TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Booked',
 cost INTEGER NOT NULL DEFAULT 0 CHECK(cost>=0),created_at INTEGER NOT NULL DEFAULT(unixepoch()),updated_at INTEGER NOT NULL DEFAULT(unixepoch()), PRIMARY KEY(case_id,direction)
);
CREATE TABLE IF NOT EXISTS rma_replacements (
 id TEXT PRIMARY KEY,case_id TEXT NOT NULL UNIQUE REFERENCES rma_cases(id),state TEXT NOT NULL CHECK(state IN('reserved','ready','shipped','delivered','cancelled')),
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE IF NOT EXISTS rma_ledger (
 id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES rma_cases(id),kind TEXT NOT NULL,amount INTEGER NOT NULL,
 reference TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT(unixepoch()),UNIQUE(case_id,kind)
);
CREATE TRIGGER IF NOT EXISTS rma_ledger_immutable BEFORE UPDATE ON rma_ledger BEGIN SELECT RAISE(ABORT,'RMA records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS rma_ledger_no_delete BEFORE DELETE ON rma_ledger BEGIN SELECT RAISE(ABORT,'RMA records are immutable'); END;
CREATE TABLE IF NOT EXISTS rma_credit (
 code TEXT PRIMARY KEY REFERENCES discounts(code),case_id TEXT NOT NULL UNIQUE REFERENCES rma_cases(id),email TEXT NOT NULL COLLATE NOCASE,
 issued INTEGER NOT NULL CHECK(issued>0),balance INTEGER NOT NULL CHECK(balance>=0),created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE IF NOT EXISTS rma_credit_uses (
 order_id TEXT PRIMARY KEY REFERENCES orders(id),code TEXT NOT NULL REFERENCES rma_credit(code),amount INTEGER NOT NULL CHECK(amount>0),released INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS rma_credit_guard BEFORE INSERT ON orders WHEN EXISTS(SELECT 1 FROM rma_credit WHERE code=NEW.discount_code) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM rma_credit c JOIN customers u ON u.id=NEW.customer_id WHERE c.code=NEW.discount_code AND c.email=NEW.email COLLATE NOCASE AND c.email=u.email COLLATE NOCASE AND c.balance>=NEW.discount AND NEW.discount>0)
 THEN RAISE(ABORT,'Sign in to use your store credit') END;
END;
CREATE TRIGGER IF NOT EXISTS rma_credit_consume AFTER INSERT ON orders WHEN EXISTS(SELECT 1 FROM rma_credit WHERE code=NEW.discount_code) BEGIN
 INSERT INTO rma_credit_uses(order_id,code,amount) VALUES(NEW.id,NEW.discount_code,NEW.discount);
 UPDATE rma_credit SET balance=balance-NEW.discount WHERE code=NEW.discount_code;
 UPDATE discounts SET value=max(1,(SELECT balance FROM rma_credit WHERE code=NEW.discount_code)),active=CASE WHEN (SELECT balance FROM rma_credit WHERE code=NEW.discount_code)>0 THEN 1 ELSE 0 END WHERE code=NEW.discount_code;
END;
CREATE TRIGGER IF NOT EXISTS rma_credit_release AFTER UPDATE OF status ON orders WHEN NEW.status='cancelled' AND OLD.status<>'cancelled' BEGIN
 UPDATE rma_credit SET balance=balance+(SELECT amount FROM rma_credit_uses WHERE order_id=NEW.id AND released=0) WHERE code IN(SELECT code FROM rma_credit_uses WHERE order_id=NEW.id AND released=0);
 UPDATE discounts SET value=(SELECT balance FROM rma_credit WHERE code=discounts.code),active=1 WHERE code IN(SELECT code FROM rma_credit_uses WHERE order_id=NEW.id AND released=0);
 UPDATE rma_credit_uses SET released=1 WHERE order_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS rma_approve_stock BEFORE UPDATE OF state ON rma_cases WHEN NEW.state='approved' AND OLD.state='requested' AND NEW.kind='exchange' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM rma_lines l LEFT JOIN variants v ON v.id=l.replacement_id LEFT JOIN products p ON p.id=v.product_id WHERE l.case_id=NEW.id AND (v.id IS NULL OR v.inventory IS NULL OR v.inventory<(SELECT sum(quantity) FROM rma_lines WHERE case_id=NEW.id AND replacement_id=v.id) OR v.price<>l.replacement_price OR v.active<>1 OR p.status<>'active' OR p.preorder<>0)) THEN RAISE(ABORT,'Replacement stock changed') END;
END;
CREATE TRIGGER IF NOT EXISTS rma_restock_guard BEFORE UPDATE OF restocked ON rma_lines WHEN NEW.restocked=1 AND OLD.restocked=0 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM variants WHERE id=NEW.variant_id AND inventory IS NOT NULL) THEN RAISE(ABORT,'Restock requires verified inventory') END;
END;
CREATE TRIGGER IF NOT EXISTS rma_order_refund_guard BEFORE UPDATE OF payment_status ON orders WHEN NEW.payment_status='refunded' AND OLD.payment_status<>'refunded' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM rma_cases WHERE source_key='website:'||NEW.id AND state NOT IN('declined','cancelled')) THEN RAISE(ABORT,'Settle refunds through the returns workspace') END;
END;
CREATE TRIGGER IF NOT EXISTS rma_legacy_refund_guard BEFORE UPDATE OF state ON order_returns WHEN NEW.state='completed' AND NEW.kind='refund' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM rma_cases WHERE source_key='website:'||NEW.order_id AND state NOT IN('declined','cancelled')) THEN RAISE(ABORT,'Settle overlapping refunds through the returns workspace') END;
END;
CREATE TRIGGER IF NOT EXISTS rma_settlement_guard BEFORE UPDATE OF state ON rma_cases WHEN NEW.state='completed' AND OLD.state<>'completed' BEGIN
 SELECT CASE WHEN NEW.payment_verified<>1 THEN RAISE(ABORT,'Original payment not verified') END;
 SELECT CASE WHEN -min(NEW.settlement,0)+coalesce((SELECT sum(-min(l.amount,0)) FROM rma_ledger l JOIN rma_cases c ON c.id=l.case_id WHERE c.source_key=NEW.source_key AND c.id<>NEW.id AND l.kind IN('refund','credit','exchange')),0)+coalesce((SELECT sum(refund_amount) FROM order_returns WHERE 'website:'||order_id=NEW.source_key AND state='completed'),0)>coalesce(json_extract(NEW.snapshot,'$.total'),0)-coalesce(json_extract(NEW.snapshot,'$.refunded'),0) THEN RAISE(ABORT,'Refund exceeds paid balance') END;
END;
CREATE TRIGGER IF NOT EXISTS rma_settlement_provider_guard BEFORE UPDATE OF state ON rma_cases WHEN NEW.state='completed' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM rma_operations WHERE case_id=NEW.id AND kind='refund' AND state<>'succeeded') THEN RAISE(ABORT,'Refund provider outcome needs review') END;
END;
CREATE TRIGGER IF NOT EXISTS rma_refund_claim_guard BEFORE INSERT ON rma_operations WHEN NEW.kind='refund' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM rma_operations op JOIN rma_cases other ON other.id=op.case_id JOIN rma_cases current ON current.id=NEW.case_id WHERE other.source_key=current.source_key AND op.kind='refund' AND op.state IN('running','review')) THEN RAISE(ABORT,'Another refund needs reconciliation') END;
 SELECT CASE WHEN NEW.amount+(SELECT coalesce(sum(op.amount),0) FROM rma_operations op JOIN rma_cases other ON other.id=op.case_id JOIN rma_cases current ON current.id=NEW.case_id WHERE other.source_key=current.source_key AND op.kind='refund' AND NOT EXISTS(SELECT 1 FROM rma_ledger l WHERE l.case_id=op.case_id AND l.kind IN('refund','exchange')))+(SELECT coalesce(sum(-min(l.amount,0)),0) FROM rma_ledger l JOIN rma_cases other ON other.id=l.case_id JOIN rma_cases current ON current.id=NEW.case_id WHERE other.source_key=current.source_key AND l.kind IN('refund','credit','exchange'))+(SELECT coalesce(sum(r.refund_amount),0) FROM order_returns r JOIN rma_cases c ON c.id=NEW.case_id WHERE c.source_key='website:'||r.order_id AND r.state='completed')>(SELECT json_extract(snapshot,'$.total')-coalesce(json_extract(snapshot,'$.refunded'),0) FROM rma_cases WHERE id=NEW.case_id) THEN RAISE(ABORT,'Refund exceeds paid balance') END;
END;
CREATE UNIQUE INDEX IF NOT EXISTS rma_financial_reference ON rma_ledger(kind,reference COLLATE NOCASE) WHERE kind IN('refund','difference') AND reference<>'';
