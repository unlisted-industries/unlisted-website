-- Additive finance upgrade; existing commerce and phase-one records are preserved.
CREATE TABLE IF NOT EXISTS finance_journals (
 id TEXT PRIMARY KEY, source TEXT NOT NULL UNIQUE, occurred_on TEXT NOT NULL,
 kind TEXT NOT NULL,campaign_id TEXT, category TEXT NOT NULL DEFAULT 'other', drop_id TEXT,
 note TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL, postings TEXT NOT NULL CHECK(json_valid(postings)),
 reversal_of TEXT UNIQUE REFERENCES finance_journals(id), created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX IF NOT EXISTS finance_journals_date ON finance_journals(occurred_on);
CREATE TRIGGER IF NOT EXISTS finance_journal_balance BEFORE INSERT ON finance_journals BEGIN
 SELECT CASE WHEN json_array_length(NEW.postings)<2 OR
 (SELECT coalesce(sum(json_extract(value,'$.amount')),1) FROM json_each(NEW.postings))<>0 OR
 EXISTS(SELECT 1 FROM json_each(NEW.postings) WHERE json_type(value,'$.amount') IS NOT 'integer' OR json_type(value,'$.account') IS NOT 'text' OR
 abs(json_extract(value,'$.amount'))>1000000000 OR json_extract(value,'$.amount')=0 OR
 json_extract(value,'$.account') NOT IN('bank','cash','unallocated','inventory','supplier_payable','loans','capital','drawings','revenue','expense','pr_expense','transfers','reconciliation','ad_clearing'))
 THEN RAISE(ABORT,'Journal must contain balanced, valid integer postings') END;
END;
CREATE TRIGGER IF NOT EXISTS finance_journal_immutable BEFORE UPDATE ON finance_journals BEGIN SELECT RAISE(ABORT,'Reverse a journal to correct it'); END;
CREATE TRIGGER IF NOT EXISTS finance_journal_no_delete BEFORE DELETE ON finance_journals BEGIN SELECT RAISE(ABORT,'Reverse a journal to correct it'); END;
CREATE TABLE IF NOT EXISTS finance_requests (id TEXT PRIMARY KEY, digest TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TABLE IF NOT EXISTS finance_audit (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TRIGGER IF NOT EXISTS finance_audit_immutable BEFORE UPDATE ON finance_audit BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS finance_audit_no_delete BEFORE DELETE ON finance_audit BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
CREATE TABLE IF NOT EXISTS finance_cost_history (id TEXT PRIMARY KEY, variant_id TEXT NOT NULL REFERENCES variants(id), unit_cost INTEGER NOT NULL CHECK(unit_cost>=0), effective_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE INDEX IF NOT EXISTS finance_cost_history_variant ON finance_cost_history(variant_id,effective_at DESC);
CREATE TABLE IF NOT EXISTS finance_order_costs (order_id TEXT NOT NULL,variant_id TEXT NOT NULL,unit_cost INTEGER,drop_id TEXT, PRIMARY KEY(order_id,variant_id));
CREATE TABLE IF NOT EXISTS finance_thresholds (variant_id TEXT PRIMARY KEY REFERENCES variants(id),threshold INTEGER NOT NULL CHECK(threshold>=0),target INTEGER NOT NULL CHECK(target>threshold));
CREATE TABLE IF NOT EXISTS finance_batches (id TEXT PRIMARY KEY,drop_id TEXT NOT NULL REFERENCES finance_drops(id),variant_id TEXT NOT NULL REFERENCES variants(id),name TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>0),cost INTEGER NOT NULL CHECK(cost>0),components TEXT NOT NULL CHECK(json_valid(components)),state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN('planned','received')), received_on TEXT, created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TABLE IF NOT EXISTS finance_imports (id TEXT PRIMARY KEY,digest TEXT NOT NULL UNIQUE,name TEXT NOT NULL,mime TEXT NOT NULL,media_key TEXT,extracted TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL DEFAULT 'review' CHECK(state IN('review','confirmed','rejected')),created_by TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TABLE IF NOT EXISTS finance_notifications (id TEXT PRIMARY KEY,dedupe TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TABLE IF NOT EXISTS finance_email_outbox (id TEXT PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES finance_notifications(id),recipient TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,sent_at INTEGER,UNIQUE(notification_id,recipient));
CREATE TABLE IF NOT EXISTS finance_settings (id INTEGER PRIMARY KEY CHECK(id=1),daily_reminder INTEGER NOT NULL DEFAULT 1,email_reminder INTEGER NOT NULL DEFAULT 1,reserve INTEGER NOT NULL DEFAULT 0,runway_days INTEGER NOT NULL DEFAULT 30,updated_at INTEGER NOT NULL DEFAULT(unixepoch()));
INSERT OR IGNORE INTO finance_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS finance_meta_daily (day TEXT NOT NULL,campaign_id TEXT NOT NULL,campaign_name TEXT NOT NULL,spend INTEGER NOT NULL CHECK(spend>=0),purchases REAL NOT NULL DEFAULT 0,purchase_value INTEGER NOT NULL DEFAULT 0,clicks INTEGER NOT NULL DEFAULT 0,impressions INTEGER NOT NULL DEFAULT 0,synced_at INTEGER NOT NULL DEFAULT(unixepoch()), PRIMARY KEY(day,campaign_id));
CREATE TABLE IF NOT EXISTS finance_meta_sync (id INTEGER PRIMARY KEY CHECK(id=1),last_success INTEGER,last_error TEXT NOT NULL DEFAULT '',currency TEXT NOT NULL DEFAULT 'EGP');
CREATE TABLE IF NOT EXISTS finance_order_attribution (source TEXT NOT NULL CHECK(source IN('website','shopify')),order_id TEXT NOT NULL,campaign_id TEXT NOT NULL,PRIMARY KEY(source,order_id));
CREATE TABLE IF NOT EXISTS finance_order_links (website_order_id TEXT PRIMARY KEY REFERENCES orders(id),shopify_source_id TEXT NOT NULL UNIQUE REFERENCES shopify_orders(source_id));
CREATE TABLE IF NOT EXISTS finance_historical_costs (source TEXT NOT NULL,order_id TEXT NOT NULL,variant_key TEXT NOT NULL,unit_cost INTEGER NOT NULL CHECK(unit_cost>=0),actor TEXT NOT NULL,PRIMARY KEY(source,order_id,variant_key));
CREATE TABLE IF NOT EXISTS finance_pr_details (gift_id TEXT PRIMARY KEY REFERENCES finance_pr_gifts(id),shipping INTEGER NOT NULL DEFAULT 0,campaign_id TEXT NOT NULL DEFAULT '',journal_id TEXT REFERENCES finance_journals(id));
CREATE TABLE IF NOT EXISTS finance_return_inventory (return_id TEXT PRIMARY KEY REFERENCES order_returns(id),restocked INTEGER NOT NULL CHECK(restocked IN(0,1)),occurred_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TRIGGER IF NOT EXISTS finance_capture_sale_cost AFTER INSERT ON order_items BEGIN
 INSERT OR IGNORE INTO finance_order_costs(order_id,variant_id,unit_cost,drop_id) SELECT NEW.order_id,NEW.variant_id,c.unit_cost,d.drop_id FROM variants v LEFT JOIN finance_variant_costs c ON c.variant_id=v.id LEFT JOIN finance_drop_products d ON d.product_id=v.product_id WHERE v.id=NEW.variant_id;
END;
CREATE TRIGGER IF NOT EXISTS finance_liability_guard BEFORE INSERT ON finance_journals WHEN NEW.kind IN('debt_out','supplier_payment') BEGIN
 SELECT CASE WHEN (SELECT coalesce(sum(json_extract(p.value,'$.amount')),0) FROM finance_journals j,json_each(j.postings) p WHERE json_extract(p.value,'$.account')=CASE NEW.kind WHEN 'debt_out' THEN 'loans' ELSE 'supplier_payable' END)+(SELECT coalesce(sum(json_extract(p.value,'$.amount')),0) FROM json_each(NEW.postings) p WHERE json_extract(p.value,'$.account')=CASE NEW.kind WHEN 'debt_out' THEN 'loans' ELSE 'supplier_payable' END)>0 THEN RAISE(ABORT,'Payment exceeds outstanding liability') END;
END;
CREATE TABLE IF NOT EXISTS finance_exchange_costs (return_id TEXT PRIMARY KEY REFERENCES order_returns(id),unit_cost INTEGER,variant_id TEXT NOT NULL,drop_id TEXT);
CREATE TABLE IF NOT EXISTS finance_payment_dates (order_id TEXT PRIMARY KEY REFERENCES orders(id),paid_at INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS finance_capture_payment_date AFTER UPDATE OF payment_status ON orders WHEN NEW.payment_status='paid' AND OLD.payment_status<>'paid' BEGIN
 INSERT OR IGNORE INTO finance_payment_dates(order_id,paid_at) VALUES(NEW.id,unixepoch());
END;
CREATE TABLE IF NOT EXISTS finance_advice (id TEXT PRIMARY KEY,question TEXT NOT NULL,response TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TRIGGER IF NOT EXISTS finance_batch_receipt_guard BEFORE UPDATE OF state ON finance_batches WHEN NEW.state='received' AND OLD.state='planned' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM variants v LEFT JOIN finance_variant_costs c ON c.variant_id=v.id WHERE v.id=NEW.variant_id AND v.inventory IS NOT NULL AND (v.inventory=0 OR c.unit_cost IS NOT NULL)) THEN RAISE(ABORT,'Verified stock and cost are required for receipt') END;
END;
CREATE TRIGGER IF NOT EXISTS finance_pr_cost_guard BEFORE INSERT ON finance_pr_gifts BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM finance_variant_costs WHERE variant_id=NEW.variant_id AND unit_cost=NEW.cost_per_unit) THEN RAISE(ABORT,'Product cost changed; review the gift again') END;
END;
