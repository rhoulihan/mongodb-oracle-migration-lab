with lines as (
  select json_value(o.data, '$.subscriber.id' returning varchar2(10)) subscriber_id,
         json_value(o.data, '$._id' returning varchar2(24))           order_id,
         o.data.placedAt.timestamp()                                    placed_at,
         l.sku, l.qty, l.price
    from "orders" o,
         json_table(o.data, '$.lines[*]' columns (
           sku   varchar2(20) path '$.sku',
           qty   number       path '$.qty',
           price number       path '$.price')) l
   where o.data.placedAt.timestamp() >= :fromTs
     and o.data.placedAt.timestamp() <  :toTs
),
spend as (
  select l.subscriber_id,
         sum(l.qty * l.price) spend,
         max(case when c.data.kind.string() = 'plan'
                  then json_value(c.data, '$.name' returning varchar2(60)) end)
           keep (dense_rank last order by case when c.data.kind.string() = 'plan' then 1 else 0 end,
                                          l.placed_at, l.order_id) plan
    from lines l
    join "catalog" c on c.data."_id".string() = l.sku
   group by l.subscriber_id
),
ranked as (
  select a.data.region.string() region,
         a.data.tier.string()   tier,
         sp.subscriber_id,
         s.data.name.string()   name,
         sp.plan,
         sp.spend,
         rank() over (partition by a.data.region.string(), a.data.tier.string()
                      order by sp.spend desc, sp.subscriber_id) rnk
    from spend sp
    join "subscribers" s on s.data."_id".string() = sp.subscriber_id
    join "accounts"    a on a.data."_id".string() = s.data.accountId.string()
)
select json {'region' : region, 'tier' : tier, 'rank' : rnk, 'subscriberId' : subscriber_id,
             'name' : name, 'plan' : plan, 'spend' : json_scalar(spend as decimal)}
  from ranked
 where rnk <= 5
 order by region, tier, rnk
